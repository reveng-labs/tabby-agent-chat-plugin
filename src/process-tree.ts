import { promises as fs } from 'fs'
import { spawn } from 'child_process'

export interface RawProc {
  pid: number
  ppid: number
  command: string
  cmdline?: string
}

const CONCURRENCY = 16

// Reading /proc/<pid>/cmdline: argv joined with NULs; collapse to spaces.
async function readLinuxCmdline (pid: number): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(`/proc/${pid}/cmdline`)
    return buf.toString('utf8').replace(/\0+$/, '').replace(/\0/g, ' ')
  } catch {
    return undefined
  }
}

function basename (cmd: string): string {
  const first = cmd.split(' ')[0] || ''
  return first.split('/').pop() || first
}

// Read all of /proc once, build pid → ppid, then BFS from rootPid (inclusive)
// to find every descendant. /proc/<pid>/stat has the form
// `<pid> (<comm-with-spaces-and-parens>) <state> <ppid> …`. Splitting on
// the last ')' avoids parens-in-comm.
async function enumerateLinux (rootPid: number, timeoutMs: number): Promise<RawProc[]> {
  const deadline = Date.now() + timeoutMs
  const entries = await fs.readdir('/proc')
  const procs = new Map<number, { pid: number, ppid: number }>()
  const statReads: Array<Promise<void>> = []
  let cursor = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < entries.length) {
      if (Date.now() > deadline) return
      const name = entries[cursor++]
      const pid = parseInt(name, 10)
      if (!Number.isFinite(pid)) continue
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
        const rparen = stat.lastIndexOf(')')
        if (rparen < 0) continue
        const fields = stat.slice(rparen + 2).split(' ')
        const ppid = parseInt(fields[1], 10)
        if (Number.isFinite(ppid)) procs.set(pid, { pid, ppid })
      } catch {
        // process exited mid-scan, or denied — skip
      }
    }
  })
  await Promise.all(workers)

  const include = new Set<number>([rootPid])
  // Iterate until no new descendants found (bounded by process count, fast).
  let added = true
  while (added) {
    added = false
    for (const p of procs.values()) {
      if (include.has(p.ppid) && !include.has(p.pid)) {
        include.add(p.pid)
        added = true
      }
    }
  }

  const pids = [...include]
  const cmdlines = new Map<number, string | undefined>()
  let cIdx = 0
  const cmdWorkers = Array.from({ length: Math.min(CONCURRENCY, pids.length) }, async () => {
    while (cIdx < pids.length) {
      const pid = pids[cIdx++]
      cmdlines.set(pid, await readLinuxCmdline(pid))
    }
  })
  await Promise.all(cmdWorkers)

  const out: RawProc[] = []
  for (const pid of pids) {
    const meta = procs.get(pid)
    if (!meta && pid !== rootPid) continue
    const cmdline = cmdlines.get(pid)
    out.push({
      pid,
      ppid: meta?.ppid ?? 0,
      command: cmdline ? basename(cmdline) : '',
      cmdline,
    })
  }
  return out
}

function runWithTimeout (
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string, stderr: string, code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* gone */ }
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stderr += d.toString() })
    child.on('error', e => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

// macOS: `ps -A -ww -o pid=,ppid=,command=`. -ww keeps args ungated by terminal
// width. command= prints argv as the kernel saw it.
async function enumerateMacOS (rootPid: number, timeoutMs: number): Promise<RawProc[]> {
  const { stdout } = await runWithTimeout('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], timeoutMs)
  const procs = new Map<number, RawProc>()
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const ppid = parseInt(m[2], 10)
    const cmdline = m[3]
    if (!Number.isFinite(pid)) continue
    procs.set(pid, { pid, ppid, command: basename(cmdline), cmdline })
  }
  return descendantsOf(procs, rootPid)
}

// Windows: PowerShell with Get-CimInstance. Robust against argv with spaces
// because each row is a JSON object. ConvertTo-Json emits an array (or single
// object if one process matched — guard for that).
async function enumerateWindows (rootPid: number, timeoutMs: number): Promise<RawProc[]> {
  const script =
    "Get-CimInstance Win32_Process | " +
    "Select-Object ProcessId,ParentProcessId,Name,CommandLine | " +
    "ConvertTo-Json -Compress"
  const { stdout } = await runWithTimeout(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    timeoutMs,
  )
  let raw: any
  try { raw = JSON.parse(stdout) }
  catch { raw = [] }
  if (!Array.isArray(raw)) raw = [raw]
  const procs = new Map<number, RawProc>()
  for (const r of raw) {
    const pid = Number(r?.ProcessId)
    const ppid = Number(r?.ParentProcessId)
    if (!Number.isFinite(pid)) continue
    const cmdline: string = typeof r?.CommandLine === 'string' ? r.CommandLine : ''
    const name: string = typeof r?.Name === 'string' ? r.Name : ''
    procs.set(pid, { pid, ppid, command: name || basename(cmdline), cmdline: cmdline || undefined })
  }
  return descendantsOf(procs, rootPid)
}

function descendantsOf (procs: Map<number, RawProc>, rootPid: number): RawProc[] {
  const include = new Set<number>([rootPid])
  let added = true
  while (added) {
    added = false
    for (const p of procs.values()) {
      if (include.has(p.ppid) && !include.has(p.pid)) {
        include.add(p.pid)
        added = true
      }
    }
  }
  const out: RawProc[] = []
  for (const pid of include) {
    const meta = procs.get(pid)
    if (meta) out.push(meta)
    else if (pid === rootPid) out.push({ pid, ppid: 0, command: '', cmdline: undefined })
  }
  return out
}

// Cross-platform: enumerate a process tree rooted at rootPid (inclusive).
// Returns root + all descendants with full cmdlines where available.
export async function enumerateLocalTree (rootPid: number, timeoutMs: number): Promise<RawProc[]> {
  if (process.platform === 'linux') return enumerateLinux(rootPid, timeoutMs)
  if (process.platform === 'darwin') return enumerateMacOS(rootPid, timeoutMs)
  if (process.platform === 'win32')  return enumerateWindows(rootPid, timeoutMs)
  // BSDs, etc. — fall back to BSD ps form
  return enumerateMacOS(rootPid, timeoutMs)
}
