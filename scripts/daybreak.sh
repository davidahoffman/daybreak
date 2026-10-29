#!/bin/zsh
# Daybreak ops — install/uninstall the launchd agents, check status, test.
#
#   ./daybreak.sh install     write plists, bootstrap server (keep-alive) + prefetch (06:50/06:55/07:25 weekdays)
#   ./daybreak.sh uninstall   bootout + remove plists (state/ untouched)
#   ./daybreak.sh status      launchd, server health, dossier + ring state
#   ./daybreak.sh ring        force a test ring now
#   ./daybreak.sh call        open the web handset
#   ./daybreak.sh fixture     install the harness fixture dossier (re-dated to today)
#   ./daybreak.sh prefetch    run a real dossier gather now (the brain)
#   ./daybreak.sh logs        tail the server log

set -euo pipefail
APP_DIR="${0:A:h:h}"                       # daybreak/
STATE_DIR="$APP_DIR/state"
AGENTS_DIR="$HOME/Library/LaunchAgents"
SERVER_LABEL="com.daybreak.server"
PREFETCH_LABEL="com.daybreak.prefetch"
PORT=7745
UID_N=$(id -u)

token() { cat "$STATE_DIR/device-token" 2>/dev/null }

write_plists() {
  mkdir -p "$STATE_DIR/logs" "$AGENTS_DIR"
  cat > "$AGENTS_DIR/$SERVER_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SERVER_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>exec node "$APP_DIR/server/daybreak-server.mjs"</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <!-- Interactive: exempt from launchd's low-power spawn deferral. Without it,
       a KeepAlive respawn on battery gets "pended nondemand spawn = inefficient"
       and the server stays down indefinitely (bit 2026-07-24 after the tz-heal
       exit while post-flight on battery). -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$STATE_DIR/logs/launchd-server.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/logs/launchd-server.log</string>
</dict></plist>
EOF

  # Prefetch: weekdays at 06:50 (inside the pmset wake window — 2026-09-15's
  # wake was a 24s dark wake that died before the old 06:55 fire), 06:55, and
  # an 07:25 backstop. Redundant fires are no-ops (early-exit + lock).
  local cal=""
  for wd in 1 2 3 4 5; do
    for t in "6 50" "6 55" "7 25"; do
      cal+="<dict><key>Weekday</key><integer>$wd</integer><key>Hour</key><integer>${t%% *}</integer><key>Minute</key><integer>${t##* }</integer></dict>"
    done
  done
  cat > "$AGENTS_DIR/$PREFETCH_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$PREFETCH_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>exec "$APP_DIR/prefetch/prefetch-awake.sh"</string>
  </array>
  <key>StartCalendarInterval</key><array>$cal</array>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$STATE_DIR/logs/launchd-prefetch.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/logs/launchd-prefetch.log</string>
</dict></plist>
EOF
}

bootout() {
  launchctl bootout "gui/$UID_N/$SERVER_LABEL" 2>/dev/null || true
  launchctl bootout "gui/$UID_N/$PREFETCH_LABEL" 2>/dev/null || true
}

case "${1:-status}" in
  install)
    write_plists
    bootout
    # A manually-started server would hold port $PORT and crash-loop the agent.
    pkill -f "node.*daybreak-server.mjs" 2>/dev/null || true
    sleep 1
    launchctl bootstrap "gui/$UID_N" "$AGENTS_DIR/$SERVER_LABEL.plist"
    launchctl bootstrap "gui/$UID_N" "$AGENTS_DIR/$PREFETCH_LABEL.plist"
    launchctl kickstart "gui/$UID_N/$SERVER_LABEL" 2>/dev/null || true
    sleep 2
    echo "installed. server:"
    curl -s "http://localhost:$PORT/api/health" || echo "  (not up yet — check $STATE_DIR/logs/launchd-server.log)"
    echo "\nhandset: http://$(hostname -s | tr 'A-Z' 'a-z').local:$PORT/call"
    ;;
  uninstall)
    bootout
    rm -f "$AGENTS_DIR/$SERVER_LABEL.plist" "$AGENTS_DIR/$PREFETCH_LABEL.plist"
    echo "uninstalled (state/ kept)"
    ;;
  status)
    echo "--- launchd:"
    launchctl print "gui/$UID_N/$SERVER_LABEL" 2>/dev/null | grep -E "state|last exit" || echo "  server agent not loaded"
    launchctl print "gui/$UID_N/$PREFETCH_LABEL" 2>/dev/null | grep -E "state|last exit" || echo "  prefetch agent not loaded"
    echo "--- server:"
    curl -s -H "Authorization: Bearer $(token)" "http://localhost:$PORT/api/status" | python3 -m json.tool || echo "  server not reachable"
    ;;
  ring)     curl -s -X POST -H "Authorization: Bearer $(token)" "http://localhost:$PORT/api/test-ring"; echo ;;
  call)     open "http://localhost:$PORT/call" ;;
  fixture)  node "$APP_DIR/prefetch/prefetch.mjs" --fixture ;;
  prefetch) node "$APP_DIR/prefetch/prefetch.mjs" --force ;;
  logs)     tail -f "$STATE_DIR/logs/server.jsonl" ;;
  *) echo "usage: daybreak.sh install|uninstall|status|ring|call|fixture|prefetch|logs"; exit 1 ;;
esac
