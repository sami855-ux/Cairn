#!/usr/bin/env bash
LOG="$HOME/.local/state/cairn/cron.log"
export PATH=/usr/bin:/usr/local/bin:/bin
export DISPLAY="${DISPLAY:-:0}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
mkdir -p "$(dirname "$LOG")"
OUT=$(mktemp)
node "$HOME/Documents/Code-Project/cairn/dist/cli.js" run --apply --due "$@" >"$OUT" 2>&1
CODE=$?
while IFS= read -r line; do
  printf '%s %s\n' "$(date '+%F %T')" "$line" >> "$LOG"
done < "$OUT"
if [ "$CODE" -ne 0 ]; then
  printf '%s exit code %s\n' "$(date '+%F %T')" "$CODE" >> "$LOG"
  notify-send -u critical -a cairn "cairn run failed" "$(tail -n 3 "$OUT" | head -c 300)"
fi
rm -f "$OUT"
exit "$CODE"
