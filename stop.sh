#!/data/data/com.termux/files/usr/bin/bash
PID_FILE="$(cd "$(dirname "$0")" && pwd)/agent.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No PID file found — agent may not be running."
  exit 1
fi

PID=$(cat "$PID_FILE")
if kill "$PID" 2>/dev/null; then
  echo "Agent stopped (PID $PID)"
  rm "$PID_FILE"
else
  echo "Agent was not running (PID $PID)"
  rm "$PID_FILE"
fi
