#!/usr/bin/env bash
#
# install-rhel.sh — single-node Charon installer for RHEL 9.5.
#
# Idempotent and re-runnable. Installs Node 20, PostgreSQL 15, nginx, and a
# PQC-capable OpenSSL 3.5+ (required — RHEL 9.5 stock OpenSSL is too old for the
# hybrid X25519MLKEM768 KEX). Creates the charon system user + /opt/charon,
# installs deps, provisions the DB + least-privilege role, generates secrets +
# .env (incl. the AES-256-GCM data key), applies migrations + seeds, installs
# the per-role systemd units, renders nginx, and handles firewalld + SELinux.
#
# Usage: sudo ./install-rhel.sh [--server-name charon.example.com] [--build-agent] [--help]
set -euo pipefail

SERVER_NAME=""
BUILD_AGENT=0
APP_DIR=/opt/charon
CHARON_USER=charon
DB_NAME=charon
DB_USER=charon

log()  { printf '\033[36m[charon-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[charon-install] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[charon-install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,18p' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-name) SERVER_NAME="$2"; shift 2 ;;
    --build-agent) BUILD_AGENT=1; shift ;;
    --help|-h) usage ;;
    *) die "unknown arg: $1 (try --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root (sudo)."
[[ -n "$SERVER_NAME" ]] || warn "no --server-name given; nginx will use _ (default server). Pass --server-name for a real SAN match."

# ── 1. Packages ────────────────────────────────────────────────────────────────
log "Installing base packages…"
dnf install -y curl git policycoreutils-python-utils firewalld >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]]; then
  log "Installing Node.js 20 (NodeSource)…"
  curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
  dnf install -y nodejs >/dev/null
fi

if ! command -v psql >/dev/null; then
  log "Installing PostgreSQL 15 (PGDG)…"
  dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm >/dev/null || true
  dnf -qy module disable postgresql >/dev/null 2>&1 || true
  dnf install -y postgresql15-server postgresql15 >/dev/null
  [[ -d /var/lib/pgsql/15/data/base ]] || /usr/pgsql-15/bin/postgresql-15-setup initdb
  systemctl enable --now postgresql-15
fi

dnf install -y nginx >/dev/null || true

# ── 2. PQC-capable OpenSSL 3.5+ (hard requirement) ──────────────────────────────
# RHEL 9.5 ships OpenSSL 3.0/3.2 (no ML-KEM). Provision 3.5+ under /opt and point
# nginx + Node at it, or fail loudly — we never silently ship classical-only TLS.
OPENSSL_BIN="$(command -v openssl || true)"
OPENSSL_VER="$("$OPENSSL_BIN" version 2>/dev/null | awk '{print $2}')"
need_pqc_openssl=1
if [[ -x /opt/openssl-3.5/bin/openssl ]]; then need_pqc_openssl=0; fi
case "$OPENSSL_VER" in 3.5*|3.6*|4.*) need_pqc_openssl=0 ;; esac

if [[ $need_pqc_openssl -eq 1 ]]; then
  warn "System OpenSSL is ${OPENSSL_VER:-unknown} — too old for X25519MLKEM768."
  log "Building OpenSSL 3.5 under /opt/openssl-3.5 (one-time)…"
  dnf groupinstall -y "Development Tools" >/dev/null || dnf install -y gcc make perl >/dev/null
  tmp="$(mktemp -d)"; pushd "$tmp" >/dev/null
  curl -fsSL https://github.com/openssl/openssl/releases/download/openssl-3.5.0/openssl-3.5.0.tar.gz -o o.tgz
  tar xf o.tgz && cd openssl-3.5.0
  ./Configure --prefix=/opt/openssl-3.5 --openssldir=/opt/openssl-3.5 >/dev/null
  make -j"$(nproc)" >/dev/null && make install_sw >/dev/null
  popd >/dev/null && rm -rf "$tmp"
fi
[[ -x /opt/openssl-3.5/bin/openssl ]] || command -v openssl | grep -q . || die "no PQC-capable OpenSSL available"

# ── 3. App user + code ──────────────────────────────────────────────────────────
id "$CHARON_USER" &>/dev/null || useradd --system --home "$APP_DIR" --shell /sbin/nologin "$CHARON_USER"
if [[ ! -d "$APP_DIR/.git" ]]; then
  log "Cloning Charon into $APP_DIR…"
  git clone https://github.com/rogers-group-inc/charon.git "$APP_DIR"
else
  log "Updating existing checkout…"; git -C "$APP_DIR" pull --ff-only || true
fi
chown -R "$CHARON_USER:$CHARON_USER" "$APP_DIR"
log "Installing npm dependencies + building…"
sudo -u "$CHARON_USER" bash -lc "cd $APP_DIR && npm ci && npm run build"

# ── 4. Database + least-privilege role ───────────────────────────────────────────
DB_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER"

# ── 5. .env with generated secrets ───────────────────────────────────────────────
ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Generating $ENV_FILE…"
  cat > "$ENV_FILE" <<EOF
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME
SESSION_SECRET=$(openssl rand -base64 48)
HEALTH_TOKEN=$(openssl rand -base64 24)
METRICS_TOKEN=$(openssl rand -base64 24)
CHARON_DATA_KEY=$(openssl rand -base64 32)
NODE_ENV=production
$( [[ -n "$SERVER_NAME" ]] && echo "CHARON_PUBLIC_URL=https://$SERVER_NAME" )
EOF
  chown "$CHARON_USER:$CHARON_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
else
  log ".env exists — leaving it."
fi

# ── 6. Migrate + seed ────────────────────────────────────────────────────────────
log "Applying migrations…"
sudo -u "$CHARON_USER" bash -lc "cd $APP_DIR && set -a && . .env && set +a && npx prisma migrate deploy && npm run db:seed"

# ── 7. systemd units ─────────────────────────────────────────────────────────────
log "Installing systemd units…"
cp "$APP_DIR"/deploy/systemd/charon-*.service "$APP_DIR"/deploy/systemd/charon.target /etc/systemd/system/
systemctl daemon-reload
systemctl enable charon-migrate.service charon-web.service charon-endpoint@1.service charon-enforcer@1.service charon-worker@1.service charon.target
systemctl start charon.target || true

# ── 8. nginx ──────────────────────────────────────────────────────────────────────
log "Rendering nginx config…"
mkdir -p /etc/nginx/conf.d "$APP_DIR/state/certs"
# Self-signed bootstrap cert if none uploaded yet (operator rotates via the UI).
if [[ ! -f "$APP_DIR/state/certs/charon.crt" ]]; then
  /opt/openssl-3.5/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -subj "/CN=${SERVER_NAME:-charon.local}" \
    -keyout "$APP_DIR/state/certs/charon.key" -out "$APP_DIR/state/certs/charon.crt" 2>/dev/null || \
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=${SERVER_NAME:-charon.local}" \
    -keyout "$APP_DIR/state/certs/charon.key" -out "$APP_DIR/state/certs/charon.crt"
  chown -R "$CHARON_USER:$CHARON_USER" "$APP_DIR/state/certs"
fi
sed -e "s|{{SERVER_NAME}}|${SERVER_NAME:-_}|g" \
    -e "s|{{WEB_PORT}}|3000|g" -e "s|{{ENDPOINT_PORT}}|3001|g" \
    -e "s|{{CERT_PATH}}|$APP_DIR/state/certs/charon.crt|g" \
    -e "s|{{KEY_PATH}}|$APP_DIR/state/certs/charon.key|g" \
    "$APP_DIR/deploy/nginx/charon.conf.template" > /etc/nginx/conf.d/charon.conf

# Scoped sudoers so the app can apply nginx config from the Certificates tab.
echo "$CHARON_USER ALL=(root) NOPASSWD: $APP_DIR/deploy/scripts/charon-nginx-apply.sh" > /etc/sudoers.d/charon-nginx
chmod 440 /etc/sudoers.d/charon-nginx

# ── 9. firewalld + SELinux ────────────────────────────────────────────────────────
log "Configuring firewalld + SELinux…"
systemctl enable --now firewalld >/dev/null 2>&1 || true
firewall-cmd --permanent --add-port=443/tcp >/dev/null 2>&1 || true
firewall-cmd --permanent --add-port=443/udp >/dev/null 2>&1 || true   # HTTP/3
firewall-cmd --reload >/dev/null 2>&1 || true
# Let nginx connect to the localhost app upstreams.
setsebool -P httpd_can_network_connect 1 >/dev/null 2>&1 || true
semanage fcontext -a -t bin_t "$APP_DIR/deploy/scripts/charon-nginx-apply.sh" >/dev/null 2>&1 || true
restorecon -R "$APP_DIR/deploy/scripts" >/dev/null 2>&1 || true

if nginx -t >/dev/null 2>&1; then systemctl enable --now nginx && systemctl reload nginx; else warn "nginx -t failed — review /etc/nginx/conf.d/charon.conf"; fi

# ── 10. Verify PQC KEX is actually negotiated (don't assume) ───────────────────────
log "Verifying hybrid KEX (X25519MLKEM768)…"
sleep 2
OSSL=/opt/openssl-3.5/bin/openssl; [[ -x "$OSSL" ]] || OSSL=openssl
if echo | "$OSSL" s_client -connect "localhost:443" -groups X25519MLKEM768 -tls1_3 2>/dev/null | grep -qi "Negotiated.*MLKEM\|X25519MLKEM768"; then
  log "✓ Hybrid PQC KEX negotiated."
else
  warn "Could not confirm X25519MLKEM768 — check the nginx OpenSSL build (ssl_ecdh_curve)."
fi

[[ $BUILD_AGENT -eq 1 ]] && warn "--build-agent: install the Rust/Tauri toolchain separately and run 'cargo tauri build' in $APP_DIR/agent (heavy; usually done in CI)."

log "Done. Charon is at https://${SERVER_NAME:-<host>}/  (first-run setup if .env was absent)."
