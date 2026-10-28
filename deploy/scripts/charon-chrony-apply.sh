#!/usr/bin/env bash
#
# charon-chrony-apply.sh — privileged chrony (NTP) apply wrapper.
#
# The Charon app runs as the unprivileged `charon` user and CANNOT touch
# /etc/chrony*. Server Settings → Time & NTP renders a chrony `.sources` file to
# a staging path, then invokes THIS script via a narrowly-scoped sudoers rule:
#
#   charon ALL=(root) NOPASSWD: /opt/charon/deploy/scripts/charon-chrony-apply.sh
#
# Because it runs as root on app-supplied content, every staged line is
# re-validated here: only comments and `server <host> iburst [nts]` with a
# hostname / IP literal are accepted.
#
#   apply <staged>  install /etc/chrony.d/charon.sources, make chrony.conf read
#                   /etc/chrony.d and stop using its own pool/server lines
#                   (originals backed up once to chrony.conf.charon-orig),
#                   restart chronyd
#   disable         remove charon.sources, restore the original chrony.conf,
#                   restart chronyd
set -euo pipefail

CONF="/etc/chrony.conf"
ORIG="/etc/chrony.conf.charon-orig"
DIR="/etc/chrony.d"
LIVE="$DIR/charon.sources"
CMD="${1:?usage: charon-chrony-apply.sh apply <staged-path> | disable}"

restart() {
  systemctl restart chronyd
}

case "$CMD" in
  apply)
    STAGED="${2:?usage: charon-chrony-apply.sh apply <staged-path>}"
    [[ -f "$STAGED" ]] || { echo "staged sources not found: $STAGED" >&2; exit 2; }
    n=0
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" || "$line" == \#* ]] && continue
      if [[ ! "$line" =~ ^server\ [A-Za-z0-9.:-]{1,253}\ iburst(\ nts)?$ ]]; then
        echo "rejected staged line: $line" >&2
        exit 3
      fi
      n=$((n + 1))
    done < "$STAGED"
    (( n > 0 )) || { echo "no servers in staged sources" >&2; exit 3; }

    [[ -f "$ORIG" ]] || cp -f "$CONF" "$ORIG"
    mkdir -p "$DIR"
    install -m 0644 -o root -g root "$STAGED" "$LIVE"
    # Our sources are authoritative: comment out the distro's pool/server lines.
    sed -i -E 's/^(pool|server)[[:space:]]/#charon# &/' "$CONF"
    grep -qE "^sourcedir[[:space:]]+$DIR\$" "$CONF" || echo "sourcedir $DIR" >> "$CONF"
    restart
    echo "chronyd restarted with $n Charon-managed server(s)."
    ;;
  disable)
    rm -f "$LIVE"
    if [[ -f "$ORIG" ]]; then
      cp -f "$ORIG" "$CONF"
      rm -f "$ORIG"
    fi
    restart
    echo "Charon NTP management disabled; original chrony.conf restored."
    ;;
  *)
    echo "usage: charon-chrony-apply.sh apply <staged-path> | disable" >&2
    exit 2
    ;;
esac
