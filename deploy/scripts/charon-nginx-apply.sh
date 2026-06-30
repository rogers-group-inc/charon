#!/usr/bin/env bash
#
# charon-nginx-apply.sh — privileged nginx config apply wrapper.
#
# The Charon app process runs as the unprivileged `charon` user and CANNOT
# touch /etc/nginx. It writes the rendered config to a staging path, then
# invokes THIS script via a narrowly-scoped sudoers rule:
#
#   charon ALL=(root) NOPASSWD: /opt/charon/deploy/scripts/charon-nginx-apply.sh
#
# The script: copies the staged config into place, runs `nginx -t` to validate,
# and only reloads on success — otherwise it restores the previous config and
# exits non-zero so a bad render can never take nginx down.
#
# Usage: charon-nginx-apply.sh <staged-conf-path>
set -euo pipefail

STAGED="${1:?usage: charon-nginx-apply.sh <staged-conf-path>}"
LIVE="/etc/nginx/conf.d/charon.conf"
BACKUP="/etc/nginx/conf.d/charon.conf.bak"

if [[ ! -f "$STAGED" ]]; then
  echo "staged config not found: $STAGED" >&2
  exit 2
fi

# Back up the current live config (if any) so we can roll back.
if [[ -f "$LIVE" ]]; then
  cp -f "$LIVE" "$BACKUP"
fi

cp -f "$STAGED" "$LIVE"

if nginx -t; then
  systemctl reload nginx
  echo "nginx config applied and reloaded."
else
  echo "nginx -t failed — rolling back." >&2
  if [[ -f "$BACKUP" ]]; then
    cp -f "$BACKUP" "$LIVE"
  else
    rm -f "$LIVE"
  fi
  exit 1
fi
