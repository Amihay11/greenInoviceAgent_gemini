#!/data/data/com.termux/files/usr/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${DASHBOARD_PORT:-3001}"
PID_FILE="$SCRIPT_DIR/dashboard.pid"
LOG_FILE="$SCRIPT_DIR/dashboard.log"

# Stop any existing dashboard
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill "$OLD_PID" 2>/dev/null; then
    echo "Stopped old dashboard (PID $OLD_PID)"
  fi
  rm -f "$PID_FILE"
fi

# Start dashboard in background
nohup node "$SCRIPT_DIR/dashboard.js" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "Dashboard started — http://localhost:$PORT  (PID $!)"
echo "Logs: $LOG_FILE"
