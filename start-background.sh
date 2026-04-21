#!/data/data/com.termux/files/usr/bin/bash
# Run the agent as a hidden background process.
# Logs go to ~/greenInoviceAgent/agent.log
# To stop:  kill $(cat ~/greenInoviceAgent/agent.pid)

AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$AGENT_DIR/agent.log"
PID_FILE="$AGENT_DIR/agent.pid"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Agent is already running (PID $(cat "$PID_FILE"))"
  exit 0
fi

cd "$AGENT_DIR/agent"
nohup node index.js >> "$LOG" 2>&1 &
echo $! > "$PID_FILE"
echo "Agent started in background (PID $!)"
echo "Logs: $LOG"
echo "Stop: kill \$(cat $PID_FILE)"
