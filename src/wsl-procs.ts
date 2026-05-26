import { spawn } from 'child_process'
import { RawProc } from './process-tree'

export const WSL_QUERY_TIMEOUT_MS = 2000

// Run inside WSL via `wsl.exe -- sh -c <SCRIPT> _ <TAB_ID>`. Locates the bash
// whose /proc/<pid>/environ contains the marker, walks its descendants, emits
// "pid<TAB>ppid<TAB>cmdline" lines for each.
const WSL_QUERY_SCRIPT = `T="$1"
root=$(grep -al "TABBY_AGENT_CHAT_TAB_ID=$T" /proc/*/environ 2>/dev/null | head -1 | cut -d/ -f3)
[ -z "$root" ] && exit 0
front="$root"; all="$root"
while [ -n "$front" ]; do
  nxt=""
  for p in $front; do
    for c in $(pgrep -P "$p" 2>/dev/null); do all="$all $c"; nxt="$nxt $c"; done
  done
  front="$nxt"
done
for pid in $all; do
  if [ -e /proc/$pid/cmdline ]; then
    cmd=$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null)
    ppid=$(awk '/^PPid:/ {print $2}' /proc/$pid/status 2>/dev/null)
    printf '%s\\t%s\\t%s\\n' "$pid" "$ppid" "$cmd"
  fi
done`

export function isWslTab (tab: any): boolean {
  if (process.platform !== 'win32') return false
  const cmd: string = tab?.profile?.options?.command ?? ''
  const base = (cmd.split(/[\\/]/).pop() || '').toLowerCase()
  return /^wsl(\.exe)?$/.test(base)
}

export function queryWslProcessesByTabId (tabId: string, timeoutMs: number): Promise<RawProc[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl.exe', ['--', 'sh', '-c', WSL_QUERY_SCRIPT, '_', tabId], { windowsHide: true })
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* gone */ }
      reject(new Error(`wsl.exe query timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const procs: RawProc[] = []
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const parts = line.split('\t')
        if (parts.length < 3) continue
        const pid = parseInt(parts[0], 10)
        const ppid = parseInt(parts[1], 10)
        const cmdline = parts[2].trim()
        if (!Number.isFinite(pid)) continue
        const argv0 = (cmdline.split(' ')[0] || '').split('/').pop() || ''
        procs.push({ pid, ppid, command: argv0, cmdline })
      }
      resolve(procs)
    })
  })
}
