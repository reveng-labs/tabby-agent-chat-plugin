import { spawn } from 'child_process'
import { NgZone } from '@angular/core'
import { AppService, ProfilesService, Logger } from 'tabby-core'
import { TabRegistry } from './tab-registry'
import { enumerateLocalTree, RawProc } from './process-tree'

export const MAX_TEXT_BYTES = 64 * 1024
export const PROC_TREE_TIMEOUT_MS = 2000
export const MAX_TAB_NAME_LEN = 64
export const MAX_TABS = 64
export const NEW_TAB_WAIT_MS = 15000
export const SESSION_READY_WAIT_MS = 15000
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

function queryWslProcessesByTabId (tabId: string, timeoutMs: number): Promise<RawProc[]> {
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

export function validateTabName (name: unknown): { ok: true, name: string } | { ok: false, code: string, error: string } {
  if (typeof name !== 'string') return { ok: false, code: 'invalid_args', error: 'name must be a string' }
  if (name.length === 0) return { ok: false, code: 'invalid_args', error: 'name must not be empty' }
  if (name.length > MAX_TAB_NAME_LEN) return { ok: false, code: 'invalid_args', error: `name exceeds ${MAX_TAB_NAME_LEN} chars` }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(name)) return { ok: false, code: 'invalid_args', error: 'name contains control characters' }
  return { ok: true, name }
}

export function isWslTab (tab: any): boolean {
  if (process.platform !== 'win32') return false
  const cmd: string = tab?.profile?.options?.command ?? ''
  const base = (cmd.split(/[\\/]/).pop() || '').toLowerCase()
  return /^wsl(\.exe)?$/.test(base)
}

// Walk up `.parent` to the top-level tab in `app.tabs`. The UI's rename sets
// customTitle on the top-level wrapper (a SplitTabComponent), not the inner
// terminal — so we read/write there to match what users see.
export function topLevelTab (tab: any): any {
  let t = tab
  while (t?.parent) t = t.parent
  return t
}

export function getTabName (tab: any): string | null {
  const top = topLevelTab(tab)
  const customTitle = (top as any).customTitle as string | undefined
  return customTitle && customTitle.length > 0 ? customTitle : null
}

// Tabby's PTYProxy exposes both getPID (the wrapper) and getTruePID (the
// actual shell). UAC-elevated sessions wrap the shell in a helper; trueid
// skips the helper. Returns null if the session is gone.
async function tabTruePID (tab: any): Promise<number | null> {
  try {
    const pty = tab?.session?.pty
    if (!pty) return null
    const raw = typeof pty.getTruePID === 'function'
      ? await pty.getTruePID()
      : await pty.getPID()
    const pid = Number(raw)
    return Number.isFinite(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export interface ProcessesResult {
  processes: RawProc[]
  error?: string
}

export async function listTabProcesses (tab: any): Promise<ProcessesResult> {
  let processes: RawProc[] = []
  let error: string | undefined
  if (isWslTab(tab)) {
    // We can't recover the per-tab id from the tab object directly here —
    // callers in the WSL path pass it separately. Skip WSL handling here and
    // let callers compose. Most callers don't run on Windows anyway.
  }
  const truePID = await tabTruePID(tab)
  if (truePID != null) {
    try {
      processes = await enumerateLocalTree(truePID, PROC_TREE_TIMEOUT_MS)
    } catch (e: any) {
      error = e?.message ?? String(e)
    }
  }
  return error ? { processes, error } : { processes }
}

// Combined: WSL path (if applicable) + local fallback.
export async function listTabProcessesFull (tab: any, tabId: string): Promise<ProcessesResult> {
  if (isWslTab(tab)) {
    try {
      const procs = await queryWslProcessesByTabId(tabId, WSL_QUERY_TIMEOUT_MS)
      if (procs.length > 0) return { processes: procs }
    } catch (e: any) {
      // fall through to local walk
      const localResult = await listTabProcesses(tab)
      return { ...localResult, error: localResult.error ?? (e?.message ?? String(e)) }
    }
  }
  return listTabProcesses(tab)
}

export interface ToolError { ok: false, code: string, error: string, [k: string]: any }
export function toolError (code: string, error: string, extra: Record<string, any> = {}): ToolError {
  return { ok: false, code, error, ...extra }
}

export interface SendOk { ok: true, tab_id: string, bytes_sent: number, mode: 'paste'|'keystrokes' }

export async function sendToTabLocal (
  registry: TabRegistry,
  app: AppService,
  zone: NgZone,
  args: { tab_id: string, text: string, submit?: boolean, mode?: 'auto'|'paste'|'keystrokes' },
  log?: Logger,
  reqId?: number,
): Promise<SendOk | ToolError> {
  if (typeof args?.tab_id !== 'string' || !args.tab_id) {
    return toolError('invalid_args', 'tab_id (string) is required')
  }
  if (typeof args.text !== 'string') {
    return toolError('invalid_args', 'text (string) is required')
  }
  if (args.text.length > MAX_TEXT_BYTES) {
    return toolError('invalid_args', `text exceeds ${MAX_TEXT_BYTES} chars`)
  }
  const submit: boolean = args.submit ?? true
  const reqMode: 'auto'|'paste'|'keystrokes' =
    args.mode === 'keystrokes' ? 'keystrokes'
      : args.mode === 'paste' ? 'paste'
      : 'auto'

  const entry = registry.get(args.tab_id)
  if (!entry) {
    return toolError('unknown_tab', `no tab with id ${args.tab_id}`, { available_ids: registry.list().map(e => e.id) })
  }
  // Block on session readiness so callers can chain new_tab → send_to_tab
  // without race-induced tab_not_ready failures. The lazy frontend.attach in
  // BaseTerminalTabComponent runs only after the SplitTab wrapper finishes
  // ngAfterViewInit, which depends on Angular CD firing — and CD only fires
  // for events delivered inside NgZone. Our MCP socket data callbacks land
  // outside the zone, so we re-enter it for the kick.
  if (!entry.tab.session) {
    log?.info(`[#${reqId}] send_to_tab waiting for session on ${entry.id} (hasFocus=${entry.tab.hasFocus} frontend=${!!entry.tab.frontend} content=${!!(entry.tab as any).content})`)
    const waitResult = await waitForSessionViaFocusKick(entry.tab, app, zone, SESSION_READY_WAIT_MS, log, reqId)
    if (!waitResult) {
      return toolError('tab_not_ready', `tab ${args.tab_id} has no active session (waited ${SESSION_READY_WAIT_MS}ms)`)
    }
  }

  const fe: any = entry.tab.frontend
  const supportsBP = typeof fe?.supportsBracketedPaste === 'function'
    ? !!fe.supportsBracketedPaste()
    : false
  const useBrackets =
    reqMode === 'paste' ? true
      : reqMode === 'keystrokes' ? false
      : supportsBP
  const effectiveMode: 'paste'|'keystrokes' = useBrackets ? 'paste' : 'keystrokes'

  let payload = args.text
  if (useBrackets) payload = `\x1b[200~${payload}\x1b[201~`
  if (submit) payload += '\r'

  const buf = Buffer.from(payload, 'utf8')
  try {
    entry.tab.sendInput(buf)
  } catch (e: any) {
    log?.error(`[#${reqId}] sendInput(${entry.id}) threw`, e)
    return toolError('send_failed', e?.message ?? String(e))
  }

  log?.info(`[#${reqId}] sent tab=${entry.id} mode=${reqMode}→${effectiveMode} (bp=${supportsBP}) submit=${submit} bytes=${buf.length}`)
  return { ok: true, tab_id: entry.id, bytes_sent: buf.length, mode: effectiveMode }
}

export interface RenameOk { ok: true, tab_id: string, name: string }

export function renameTabLocal (
  registry: TabRegistry,
  app: AppService,
  args: { tab_id: string, name: string },
  knownNames: Set<string>, // names known across all windows (excluding the renamed tab itself)
  log?: Logger,
  reqId?: number,
): RenameOk | ToolError {
  if (typeof args?.tab_id !== 'string' || !args.tab_id) {
    return toolError('invalid_args', 'tab_id (string) is required')
  }
  const v = validateTabName(args?.name)
  if (!v.ok) return toolError(v.code, v.error)

  const entry = registry.get(args.tab_id)
  if (!entry) {
    return toolError('unknown_tab', `no tab with id ${args.tab_id}`, { available_ids: registry.list().map(e => e.id) })
  }
  if (knownNames.has(v.name)) {
    return toolError('name_in_use', `name "${v.name}" already in use`)
  }
  try {
    const top = topLevelTab(entry.tab)
    top.customTitle = v.name
    app.emitTabsChanged()
  } catch (e: any) {
    log?.error(`[#${reqId}] rename failed`, e)
    return toolError('internal', e?.message ?? String(e))
  }
  log?.info(`[#${reqId}] renamed tab=${entry.id} name="${v.name}"`)
  return { ok: true, tab_id: entry.id, name: v.name }
}

export interface NewOk { ok: true, tab_id: string, name?: string }

export async function newTabLocal (
  registry: TabRegistry,
  app: AppService,
  profiles: ProfilesService,
  args: { name?: string },
  knownNames: Set<string>,
  totalTabsAcrossWindows: number,
  log?: Logger,
  reqId?: number,
): Promise<NewOk | ToolError> {
  if (totalTabsAcrossWindows >= MAX_TABS) {
    return toolError('too_many_tabs', `tab cap reached (${totalTabsAcrossWindows}/${MAX_TABS}); refusing to open new tab`)
  }
  let validatedName: string | undefined
  if (args?.name !== undefined) {
    const v = validateTabName(args.name)
    if (!v.ok) return toolError(v.code, v.error)
    validatedName = v.name
    if (knownNames.has(validatedName)) {
      return toolError('name_in_use', `name "${validatedName}" already in use`)
    }
  }

  let profile: any
  try {
    const all = await profiles.getProfiles()
    profile = all.find((p: any) => p.type === 'local')
    if (!profile) return toolError('no_local_profile', 'no local profile configured in Tabby')
  } catch (e: any) {
    log?.error(`[#${reqId}] new_tab: getProfiles failed`, e)
    return toolError('internal', e?.message ?? String(e))
  }

  let wrapper: any
  try {
    wrapper = await profiles.openNewTabForProfile(profile)
    if (!wrapper) return toolError('open_failed', 'openNewTabForProfile returned null')
  } catch (e: any) {
    log?.error(`[#${reqId}] new_tab: openNewTabForProfile failed`, e)
    return toolError('internal', e?.message ?? String(e))
  }

  const newId = await waitForWrapperRegistered(registry, wrapper, NEW_TAB_WAIT_MS)
  if (!newId) {
    return toolError('register_timeout', `new tab did not register within ${NEW_TAB_WAIT_MS}ms`)
  }
  const entry = registry.get(newId)
  if (!entry) {
    return toolError('internal', `tab ${newId} disappeared after registration`)
  }
  // We don't block on session attachment here: BaseTerminalTabComponent
  // lazily attaches the xterm frontend on first focused$ emission, which can
  // arrive much later in unfocused/headless windows. send_to_tab handles the
  // wait itself so callers can chain new_tab → send_to_tab cleanly.

  if (validatedName) {
    try {
      const top = topLevelTab(entry.tab)
      top.customTitle = validatedName
      app.emitTabsChanged()
    } catch (e: any) {
      log?.warn(`[#${reqId}] new_tab: rename after open failed: ${e?.message}`)
    }
  }
  log?.info(`[#${reqId}] new_tab id=${newId}${validatedName ? ` name="${validatedName}"` : ''}`)
  return { ok: true, tab_id: newId, name: validatedName }
}

async function waitForWrapperRegistered (registry: TabRegistry, wrapper: any, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const candidates: any[] = typeof wrapper?.getAllTabs === 'function'
      ? wrapper.getAllTabs()
      : [wrapper]
    for (const c of candidates) {
      for (const e of registry.list()) {
        if (e.tab === c) return e.id
      }
    }
    await new Promise(r => setTimeout(r, 100))
  }
  return null
}

// Wait for the tab's session to attach. Resolves on sessionChanged$ emit;
// periodically calls app.selectTab(wrapper) inside NgZone to kick Angular's
// change detection — the lazy frontend.attach chain depends on splitTab's
// ngAfterViewInit, which only runs once CD renders the wrapper. When our
// socket callback fires outside the zone, CD doesn't see it, so we re-enter.
async function waitForSessionViaFocusKick (
  tab: any,
  app: AppService,
  zone: NgZone,
  timeoutMs: number,
  log?: Logger,
  reqId?: number,
): Promise<boolean> {
  if (tab?.session) return true
  const wrapper = topLevelTab(tab)
  return new Promise(resolve => {
    let settled = false
    let kicks = 0
    const t0 = Date.now()
    const finish = (ok: boolean, via: string) => {
      if (settled) return
      settled = true
      try { sub?.unsubscribe?.() } catch { /* gone */ }
      clearInterval(kicker)
      clearTimeout(timer)
      log?.info(`[#${reqId}] waitForSession finished ok=${ok} via=${via} kicks=${kicks} elapsedMs=${Date.now() - t0} hasFocus=${tab?.hasFocus} frontend=${!!tab?.frontend}`)
      resolve(ok)
    }
    const stream: any = tab?.sessionChanged$
    const sub = stream?.subscribe?.((s: any) => { if (s) finish(true, 'sessionChanged$') })
    const kicker = setInterval(() => {
      if (tab?.session) { finish(true, 'kicker-poll'); return }
      kicks++
      zone.run(() => {
        try { app.selectTab(wrapper) } catch { /* wrapper gone */ }
      })
      if (kicks <= 3 || kicks % 10 === 0) {
        log?.info(`[#${reqId}] kick #${kicks} hasFocus=${tab?.hasFocus} frontend=${!!tab?.frontend} content=${!!(tab as any)?.content}`)
      }
    }, 200)
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
    if (tab?.session) finish(true, 'pre-promise-race')
  })
}
