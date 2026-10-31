#!/usr/bin/env bash
LOG="${XDG_STATE_HOME:-$HOME/.local/state}/cairn/cron.log"
export PATH=/usr/bin:/usr/local/bin:/bin
export DISPLAY="${DISPLAY:-:0}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
mkdir -p "$(dirname "$LOG")"
OUT=$(mktemp)
node "$HOME/Documents/Code-Project/cairn/dist/cli.js" run --apply --due --no-notify "$@" >"$OUT" 2>&1
CODE=$?
while IFS= read -r line; do
  printf '%s %s\n' "$(date '+%F %T')" "$line" >> "$LOG"
done < "$OUT"
if [ "$CODE" -ne 0 ]; then
  printf '%s exit code %s\n' "$(date '+%F %T')" "$CODE" >> "$LOG"
fi
rm -f "$OUT"
exit "$CODE"
