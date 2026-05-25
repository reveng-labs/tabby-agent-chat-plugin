#!/bin/sh
# Kill the debug Tabby Electron process tree.
# Match a substring that only appears in Electron's argv, not in
# any wrapping shell that may have invoked us (whose argv could
# contain user-data-dir paths).
PIDS=$(pgrep -f 'electron/dist/electron .* /home/user/tabby/debug-userdata' 2>/dev/null || true)
if [ -z "$PIDS" ]; then
  # Fallback: any electron process for the debug userdata dir.
  PIDS=$(pgrep -f 'electron/dist/electron' 2>/dev/null | while read p; do
    if grep -aq 'debug-userdata' "/proc/$p/cmdline" 2>/dev/null; then echo "$p"; fi
  done)
fi
for p in $PIDS; do
  kill -9 "$p" 2>/dev/null || true
done
exit 0
