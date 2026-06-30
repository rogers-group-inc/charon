#!/usr/bin/env bash
#
# setup-ha.sh — second-node / HA configurator. Run on the PRIMARY first, then
# the STANDBY. Sets up PostgreSQL streaming replication and the app-side HA env
# so only the leader (advisory-lock holder) runs schedulers/enforcement.
#
# Usage:
#   On primary:  sudo ./setup-ha.sh --role primary --standby-ip <DC-B-ip>
#   On standby:  sudo ./setup-ha.sh --role standby --primary-ip <DC-A-ip>
#
# Cross-DC replication should run over TLS 1.3 (PQC-hybrid where the OpenSSL
# build supports it) — set ssl=on in postgresql.conf + hostssl in pg_hba.
set -euo pipefail

ROLE="" PRIMARY_IP="" STANDBY_IP=""
PGDATA=/var/lib/pgsql/15/data
REPL_USER=charon_repl

log() { printf '\033[36m[charon-ha]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[charon-ha] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --primary-ip) PRIMARY_IP="$2"; shift 2 ;;
    --standby-ip) STANDBY_IP="$2"; shift 2 ;;
    --help|-h) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done
[[ $EUID -eq 0 ]] || die "run as root."
[[ "$ROLE" == "primary" || "$ROLE" == "standby" ]] || die "--role must be primary|standby"

if [[ "$ROLE" == "primary" ]]; then
  [[ -n "$STANDBY_IP" ]] || die "--standby-ip required on the primary"
  log "Configuring PRIMARY for streaming replication…"
  REPL_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$REPL_USER'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE ROLE $REPL_USER WITH REPLICATION LOGIN PASSWORD '$REPL_PASS'"
  # WAL settings for streaming + a replication slot.
  sudo -u postgres psql -c "ALTER SYSTEM SET wal_level = replica"
  sudo -u postgres psql -c "ALTER SYSTEM SET max_wal_senders = 10"
  sudo -u postgres psql -c "ALTER SYSTEM SET wal_keep_size = '1GB'"
  sudo -u postgres psql -c "ALTER SYSTEM SET ssl = on"
  sudo -u postgres psql -c "SELECT pg_create_physical_replication_slot('charon_standby')" 2>/dev/null || true
  # Allow the standby to connect (TLS-only).
  HBA="$PGDATA/pg_hba.conf"
  grep -q "charon_standby_repl" "$HBA" 2>/dev/null || \
    echo "hostssl replication $REPL_USER ${STANDBY_IP}/32 scram-sha-256  # charon_standby_repl" >> "$HBA"
  systemctl restart postgresql-15
  firewall-cmd --permanent --add-port=5432/tcp >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  log "PRIMARY ready. Replication user: $REPL_USER  password: $REPL_PASS"
  log "Run on the standby:  sudo ./setup-ha.sh --role standby --primary-ip <THIS-NODE-IP>"
  echo "$REPL_PASS" > /root/.charon_repl_pass; chmod 600 /root/.charon_repl_pass
else
  [[ -n "$PRIMARY_IP" ]] || die "--primary-ip required on the standby"
  log "Configuring STANDBY (base-backup from $PRIMARY_IP)…"
  systemctl stop postgresql-15 || true
  rm -rf "${PGDATA:?}/"*
  read -r -s -p "Replication password (from primary /root/.charon_repl_pass): " REPL_PASS; echo
  PGPASSWORD="$REPL_PASS" sudo -u postgres /usr/pgsql-15/bin/pg_basebackup \
    -h "$PRIMARY_IP" -U "$REPL_USER" -D "$PGDATA" -Fp -Xs -P -R -S charon_standby --sslmode=require
  sudo -u postgres touch "$PGDATA/standby.signal"
  systemctl start postgresql-15
  log "STANDBY streaming. Verify on the primary: SELECT * FROM pg_stat_replication;"
fi

# ── App HA env (both nodes) ───────────────────────────────────────────────────
ENV_FILE=/opt/charon/.env
if [[ -f "$ENV_FILE" ]]; then
  grep -q CHARON_LEADER_LOCK_KEY "$ENV_FILE" || echo "CHARON_LEADER_LOCK_KEY=728405146" >> "$ENV_FILE"
  log "App HA env present. Both nodes contend on the same advisory lock; only the leader runs schedulers/enforcement."
  log "Point the GSLB at each node's /health (it reports {isLeader, role}); steer to the leader's DC."
fi

cat <<'CHECK'

── Verification checklist ─────────────────────────────────────────────
  Primary:   SELECT client_addr, state, sync_state FROM pg_stat_replication;
  Standby:   SELECT pg_is_in_recovery();              -- expect t
  Lag:       SELECT pg_last_wal_replay_lsn();
  Leader:    curl -sk https://<node>/health           -- one node isLeader:true
  Failover:  see deploy/HA.md
───────────────────────────────────────────────────────────────────────
CHECK
