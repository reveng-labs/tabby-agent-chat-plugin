#!/bin/bash
WS=$(curl -s http://127.0.0.1:9333/json | grep webSocketDebuggerUrl | head -1 | sed -E 's/.*"(ws:[^"]+)".*/\1/')
LOG=/home/user/tabby-agent-chat-plugin/experiments/circular/snapshot.log
START=$(cat /home/user/tabby-agent-chat-plugin/experiments/circular/start_time)
DEADLINE=$((START + 300))
while [ $(date +%s) -lt $DEADLINE ]; do
  echo "============ SNAPSHOT $(date) ============" >> $LOG
  for NAME in claude-1 claude-2 claude-3; do
    echo "----- $NAME -----" >> $LOG
    node /home/user/tabby-agent-chat-plugin/scripts/cdp-eval.cjs "$WS" "
    (function(){
      const app = window.ng.getComponent(document.querySelector('app-root')).app;
      for (const t of app.tabs) {
        if (t.constructor.name !== 'SplitTabComponent') continue;
        for (const c of t.getAllTabs()) {
          if (c.customTitle === '$NAME') {
            const xt = c.frontend?.xterm;
            if (!xt) return 'no xterm';
            const buf = xt.buffer.active;
            const lines = [];
            for (let i = Math.max(0, buf.length - 30); i < buf.length; i++) {
              const line = buf.getLine(i);
              if (line) lines.push(line.translateToString(true));
            }
            return lines.join('\n');
          }
        }
      }
      return 'not found';
    })()" 2>&1 | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["result"]["value"])' >> $LOG
  done
  sleep 60
done
echo "============ END $(date) ============" >> $LOG
