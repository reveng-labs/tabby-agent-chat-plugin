import { NgZone } from '@angular/core'
import { AppService, ProfilesService, Logger } from 'tabby-core'
import { TabRegistry } from './tab-registry'
import { enumerateLocalTree, RawProc } from './process-tree'
import { isWslTab, queryWslProcessesByTabId, WSL_QUERY_TIMEOUT_MS } from './wsl-procs'

export const MAX_TEXT_BYTES = 64 * 1024
export const PROC_TREE_TIMEOUT_MS = 2000
export const MAX_TAB_NAME_LEN = 64
export const MAX_TABS = 64
export const NEW_TAB_WAIT_MS = 15000
export const SESSION_READY_WAIT_MS = 15000
export const PROMPT_READY_WAIT_MS = 10000

export function validateTabName (name: unknown): { ok: true, name: string } | { ok: false, code: string, error: string } {
  if (typeof name !== 'string') return { ok: false, code: 'invalid_args', error: 'name must be a string' }
  if (name.length === 0) return { ok: false, code: 'invalid_args', error: 'name must not be empty' }
  if (name.length > MAX_TAB_NAME_LEN) return { ok: false, code: 'invalid_args', error: `name exceeds ${MAX_TAB_NAME_LEN} chars` }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(name)) return { ok: false, code: 'invalid_args', error: 'name contains control characters' }
  return { ok: true, name }
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

// Host-side process walk from the tab's true PID. For a WSL tab this returns
// the Windows-side wsl.exe tree, not the processes running inside the distro —
// callers that have a tab id should use listTabProcessesFull, which queries
// inside the distro first and falls back here.
export async function listTabProcesses (tab: any): Promise<ProcessesResult> {
  let processes: RawProc[] = []
  let error: string | undefined
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

export interface ListedTab {
  id: string
  name: string | null
  processes: RawProc[]
  processes_error?: string
}

export async function listTabsLocal (registry: TabRegistry): Promise<{ tabs: ListedTab[] }> {
  const tabs = await Promise.all(registry.list().map(async e => {
    const procRes = await listTabProcessesFull(e.tab, e.id)
    const out: ListedTab = { id: e.id, name: getTabName(e.tab), processes: procRes.processes }
    if (procRes.error) out.processes_error = procRes.error
    return out
  }))
  return { tabs }
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

  // Session attached ≠ shell ready for input. The shell typically issues
  // DECSET 2004 (bracketed paste) right around the time it prints its first
  // prompt; before that, bytes written to the pty get swallowed or land in a
  // pre-prompt buffer that gets cleared. Wait for that signal (bounded so
  // exotic shells without BP still proceed via keystrokes).
  const supportsBP = await waitForBracketedPaste(entry.tab, PROMPT_READY_WAIT_MS, log, reqId)
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
  knownNames: Set<string>, // other tabs' custom names in this window (the renamed tab itself excluded)
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
  tabCount: number,
  log?: Logger,
  reqId?: number,
): Promise<NewOk | ToolError> {
  if (tabCount >= MAX_TABS) {
    return toolError('too_many_tabs', `tab cap reached (${tabCount}/${MAX_TABS}); refusing to open new tab`)
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

// Poll the frontend's bracketed-paste capability — proxy for "shell printed
// its first prompt and is now consuming input." Returns whether BP is active
// (and therefore whether the caller should wrap payloads). Bounded wait so a
// shell that never enables BP (cmd.exe, dumb terminals) still proceeds and
// the caller falls through to the keystrokes path.
async function waitForBracketedPaste (tab: any, timeoutMs: number, log?: Logger, reqId?: number): Promise<boolean> {
  const fe: any = tab?.frontend
  if (typeof fe?.supportsBracketedPaste !== 'function') return false
  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  while (!fe.supportsBracketedPaste()) {
    if (Date.now() >= deadline) {
      log?.warn(`[#${reqId}] BP wait timeout after ${timeoutMs}ms — sending as keystrokes`)
      return false
    }
    await new Promise(r => setTimeout(r, 100))
  }
  const waited = Date.now() - t0
  if (waited >= 100) log?.info(`[#${reqId}] BP ready after ${waited}ms`)
  return true
}

// Wait for the tab's session to attach. Arms a sessionChanged$ subscription
// and a periodic kicker (app.selectTab inside NgZone, to nudge Angular CD —
// the lazy frontend.attach chain runs only when SplitTab's ngAfterViewInit
// fires, which needs CD, which doesn't fire for events delivered outside the
// zone like our socket data callbacks). Then a single sync check covers the
// case where the session was already attached before we got here.
async function waitForSessionViaFocusKick (
  tab: any,
  app: AppService,
  zone: NgZone,
  timeoutMs: number,
  log?: Logger,
  reqId?: number,
): Promise<boolean> {
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
      log?.info(`[#${reqId}] waitForSession ok=${ok} via=${via} kicks=${kicks} elapsedMs=${Date.now() - t0}`)
      resolve(ok)
    }
    const sub = tab?.sessionChanged$?.subscribe?.((s: any) => { if (s) finish(true, 'sessionChanged$') })
    const kicker = setInterval(() => {
      if (tab?.session) return finish(true, 'kicker')
      kicks++
      zone.run(() => { try { app.selectTab(wrapper) } catch { /* wrapper gone */ } })
    }, 200)
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
    if (tab?.session) finish(true, 'sync')
  })
}
