#!/usr/bin/env bash
#
# docker-entrypoint.sh — per-role container entrypoint.
#
# Loads state/.env (if present), runs `prisma migrate deploy` only for the
# web/migrate roles, exits 0 for the one-shot migrate role, otherwise execs the
# app. Role is selected by CHARON_ROLE.
set -euo pipefail

# Load operator config from the mounted state volume if present.
if [[ -f /app/state/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . /app/state/.env
  set +a
fi

ROLE="${CHARON_ROLE:-all}"

run_migrations() {
  echo "[entrypoint] applying migrations (role=$ROLE)…"
  npx prisma migrate deploy
}

case "$ROLE" in
  migrate)
    run_migrations
    echo "[entrypoint] migrate role complete — exiting 0."
    exit 0
    ;;
  web|all)
    # No DATABASE_URL yet → this host still needs first-run setup. Skip
    # migrations and let the app boot the setup wizard (index.ts). The wizard's
    # finalize applies migrations itself once the operator supplies a DB.
    if [[ -n "${DATABASE_URL:-}" ]]; then
      run_migrations
    else
      echo "[entrypoint] no DATABASE_URL — starting first-run setup wizard."
    fi
    ;;
  endpoint|enforcer|worker)
    echo "[entrypoint] role=$ROLE — migrations handled by the migrate/web service."
    ;;
  *)
    echo "[entrypoint] unknown CHARON_ROLE=$ROLE — defaulting to single-process; applying migrations."
    run_migrations
    ;;
esac

exec node dist/index.js
