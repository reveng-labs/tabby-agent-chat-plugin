import { Injectable } from '@angular/core'
import { AddressInfo } from 'net'
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { spawn } from 'child_process'
import * as path from 'path'
import { AppService, LogService, Logger, ProfilesService } from 'tabby-core'
import { TabRegistry } from './tab-registry'
import pkg from '../package.json'

const MAX_BODY_BYTES = 1024 * 1024              // 1 MB hard cap
const MAX_TEXT_BYTES = 64 * 1024                // per send_to_tab payload
const CHILD_PROC_TIMEOUT_MS = 1000              // bound list_tabs latency
const MAX_TAB_NAME_LEN = 64                     // tab name length cap
const MAX_TABS = 64                             // fork-bomb cap for new_tab
const NEW_TAB_WAIT_MS = 15000                   // wait for new tab to register (high under load)
const WSL_QUERY_TIMEOUT_MS = 2000               // per-tab WSL /proc query timeout

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
      try { child.kill() } catch { /* already gone */ }
      reject(new Error(`wsl.exe query timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
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

function validateTabName (name: unknown): { ok: true, name: string } | { ok: false, code: string, error: string } {
  if (typeof name !== 'string') return { ok: false, code: 'invalid_args', error: 'name must be a string' }
  if (name.length === 0) return { ok: false, code: 'invalid_args', error: 'name must not be empty' }
  if (name.length > MAX_TAB_NAME_LEN) return { ok: false, code: 'invalid_args', error: `name exceeds ${MAX_TAB_NAME_LEN} chars` }
  // Reject C0/C1 control chars (newline, tab, BEL, etc.) — they corrupt the tab header.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(name)) return { ok: false, code: 'invalid_args', error: 'name contains control characters' }
  return { ok: true, name }
}
// INSTALL.md ships with the plugin. dist/index.js sits at
// <install>/dist/index.js, so the markdown is one dir up.
const INSTALL_FILE = path.resolve(__dirname, '..', 'INSTALL.md')

const SERVER_INSTRUCTIONS = `This server exposes terminal tabs in the current Tabby window for
agent-to-agent messaging.

WORKFLOW:
1. Call list_tabs → each tab has id, title, and processes (with cmdline).
2. Identify the target agent by inspecting cmdline of the processes in
   each tab. Examples: "node …/codex" = Codex; "claude" = Claude Code;
   "node …/aider" = Aider.
3. Call send_to_tab(tab_id, text) → injects text into the target's
   stdin as if typed.

EXAMPLE USE CASE — when the user asks "send X to the agent doing Y":
1. list_tabs to learn which agent runs in each tab (from cmdline).
2. Read each agent's transcript from its own on-disk store to find
   which one is working on Y:
     Claude Code: ~/.claude/projects/<slug>/...
     Codex:       ~/.codex/sessions/<id>/...
     Other tools: consult their respective docs.
3. send_to_tab(tab_id, "X") to that tab.`

interface RawProc { pid: number; ppid: number; command: string; cmdline?: string }

async function readCmdline (pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const buf = await fs.readFile(`/proc/${pid}/cmdline`)
    // argv is NUL-separated, often with a trailing NUL
    return buf.toString('utf8').replace(/\0+$/, '').replace(/\0/g, ' ')
  } catch {
    return undefined  // process gone, perms, /proc not mounted, etc.
  }
}

const READ_CMDLINE_CONCURRENCY = 16
async function readCmdlinesBounded (pids: number[]): Promise<Map<number, string | undefined>> {
  const out = new Map<number, string | undefined>()
  let i = 0
  const workers = Array.from(
    { length: Math.min(READ_CMDLINE_CONCURRENCY, pids.length) },
    async () => {
      while (i < pids.length) {
        const pid = pids[i++]
        out.set(pid, await readCmdline(pid))
      }
    },
  )
  await Promise.all(workers)
  return out
}

export interface StartOptions {
  registry: TabRegistry
  logSvc: LogService
  app: AppService
  profiles: ProfilesService
}

@Injectable({ providedIn: 'root' })
export class McpServer {
  private srv?: Server
  private port = 0
  private token = randomUUID()
  private log!: Logger
  private reqSeq = 0
  private starting?: Promise<void>
  private opts!: StartOptions

  async start (opts: StartOptions): Promise<void> {
    // Protect against concurrent or repeated calls: both same-tick callers
    // share the same in-flight promise; later callers see this.srv already set.
    if (this.srv) return
    if (this.starting) return this.starting
    this.starting = this._start(opts)
    try { await this.starting } finally { this.starting = undefined }
  }

  private async _start (opts: StartOptions) {
    this.opts = opts
    this.log = opts.logSvc.create('agent-chat')

    const srv = createServer((req, res) => {
      this.safeHandle(req, res, opts.registry).catch(err => {
        this.log.error('handler crashed (suppressed)', err)
        this.tryWrite(res, 500, { ok: false, code: 'internal', error: 'handler crashed' })
      })
    })
    srv.on('error', err => this.log.error('http server error', err))
    srv.on('clientError', (err, socket) => {
      this.log.warn('client error', err.message)
      try { socket.destroy() } catch { /* socket already dead */ }
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => { srv.off('listening', onListen); reject(e) }
      const onListen = () => { srv.off('error', onError); resolve() }
      srv.once('error', onError)
      srv.once('listening', onListen)
      srv.listen(0, '127.0.0.1')
    })

    const addr = srv.address()
    if (!addr || typeof addr === 'string') {
      this.log.error(`listen returned unexpected address: ${JSON.stringify(addr)}`)
      try { srv.close() } catch { /* nothing to do */ }
      throw new Error('listen returned non-AddressInfo')
    }
    this.srv = srv
    this.port = (addr as AddressInfo).port
    this.log.info(`listening on http://127.0.0.1:${this.port} (token hidden; see env TABBY_AGENT_CHAT_TOKEN)`)

    // Inject discovery vars into the renderer's env so every shell Tabby
    // spawns afterwards inherits them. Existing shells were spawned with
    // the old env (or none) and won't see this until restarted.
    process.env.TABBY_AGENT_CHAT_URL = `http://127.0.0.1:${this.port}/mcp`
    process.env.TABBY_AGENT_CHAT_TOKEN = this.token
    process.env.TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS = INSTALL_FILE
    // Tell WSL to inherit our three vars. The INSTALL path gets the /p flag
    // so wsl.exe translates "C:\\…\\INSTALL.md" to "/mnt/c/…/INSTALL.md".
    // Other vars are plain strings (URL, opaque token). Preserve any
    // pre-existing WSLENV entries the user or other tooling set.
    this.addToWslenv([
      'TABBY_AGENT_CHAT_URL',
      'TABBY_AGENT_CHAT_TOKEN',
      'TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS/p',
    ])
    this.log.info(`exported TABBY_AGENT_CHAT_URL, _TOKEN, _INSTALL_INSTRUCTIONS (incl. WSLENV propagation)`)

    this.installShutdownHooks()
  }

  private static readonly WSLENV_NAMES = new Set([
    'TABBY_AGENT_CHAT_URL',
    'TABBY_AGENT_CHAT_TOKEN',
    'TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS',
  ])

  private addToWslenv (entries: string[]) {
    const existing = (process.env.WSLENV ?? '').split(':').filter(s => s.length > 0)
    // Drop any prior copies of our own names so we don't double-list on re-init.
    const kept = existing.filter(e => !McpServer.WSLENV_NAMES.has(e.split('/')[0]))
    process.env.WSLENV = [...kept, ...entries].join(':')
  }

  private removeFromWslenv () {
    const existing = (process.env.WSLENV ?? '').split(':').filter(s => s.length > 0)
    const kept = existing.filter(e => !McpServer.WSLENV_NAMES.has(e.split('/')[0]))
    if (kept.length === 0) delete process.env.WSLENV
    else process.env.WSLENV = kept.join(':')
  }

  private installShutdownHooks () {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => { void this.stop() })
    }
  }

  async stop () {
    if (!this.srv) return
    this.log.info('stopping http server')
    delete process.env.TABBY_AGENT_CHAT_URL
    delete process.env.TABBY_AGENT_CHAT_TOKEN
    delete process.env.TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS
    this.removeFromWslenv()
    const srv = this.srv
    this.srv = undefined
    // Drop keep-alives first so close() can resolve even if a handler held a socket open.
    try { srv.closeAllConnections?.() } catch { /* nothing to do */ }
    await new Promise<void>(resolve => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        resolve()
      }
      srv.close(() => finish())
      // Hard cap: don't let a hung handler block shutdown forever.
      timer = setTimeout(finish, 2000)
      timer.unref?.()
    })
  }

  // ---------------------------------------------------------------- transport

  private async safeHandle (req: IncomingMessage, res: ServerResponse, registry: TabRegistry) {
    const reqId = ++this.reqSeq
    const t0 = Date.now()
    const remote = req.socket.remoteAddress ?? '?'
    let msg: any = null

    try {
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        this.log.warn(`[#${reqId}] 401 from ${remote}`)
        return this.tryWrite(res, 401, { ok: false, code: 'unauthorized', error: 'bad or missing token' })
      }
      if (req.method !== 'POST' || req.url !== '/mcp') {
        return this.tryWrite(res, 404, { ok: false, code: 'not_found', error: 'POST /mcp only' })
      }

      let body: string
      try {
        body = await this.readBody(req)
      } catch (e: any) {
        this.log.warn(`[#${reqId}] body read failed: ${e?.message}`)
        return this.tryWrite(res, 413, { ok: false, code: 'body_too_large', error: e?.message ?? 'body error' })
      }

      try { msg = JSON.parse(body) } catch {
        this.log.warn(`[#${reqId}] bad json (${body.length}B)`)
        return this.tryWrite(res, 400, { ok: false, code: 'bad_json', error: 'invalid json' })
      }

      const reply = await this.dispatch(msg, registry, reqId)
      if (reply === null) {
        // JSON-RPC notification — must not produce a response body.
        if (!res.writableEnded && !res.headersSent) {
          res.writeHead(204)
          res.end()
        }
      } else {
        this.tryWrite(res, 200, reply)
      }
      this.log.debug(`[#${reqId}] ${msg?.method} ${Date.now() - t0}ms`)
    } catch (e: any) {
      this.log.error(`[#${reqId}] unexpected`, e)
      // If we parsed a JSON-RPC message, preserve its id so clients can
      // correlate. Otherwise return a plain envelope.
      const body = (msg && msg.jsonrpc === '2.0')
        ? { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e?.message ?? 'internal error' } }
        : { ok: false, code: 'internal', error: e?.message ?? String(e) }
      this.tryWrite(res, 500, body)
    }
  }

  private readBody (req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        try { req.destroy() } catch { /* already destroyed */ }
        reject(err)
      }
      req.on('data', c => {
        size += c.length
        if (size > MAX_BODY_BYTES) return fail(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`))
        chunks.push(c)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', fail)
      // 'close' fires on disconnect; we treat it as failure only if the body
      // didn't complete cleanly. ('aborted' is deprecated in Node 17+ and is
      // a subset of 'close' for our purposes.)
      req.on('close', () => {
        if (!settled && !req.complete) fail(new Error('connection closed before body complete'))
      })
    })
  }

  private tryWrite (res: ServerResponse, status: number, body: any) {
    if (res.writableEnded || res.headersSent) return
    // Serialize FIRST. If stringify throws (BigInt, circular ref), we still
    // have a chance to send a meaningful error instead of a half-sent response.
    let serialized: string
    try {
      serialized = JSON.stringify(body)
    } catch (e: any) {
      this.log.warn(`response serialize failed: ${e?.message}`)
      try { serialized = JSON.stringify({ ok: false, code: 'serialize_failed', error: String(e?.message ?? e) }) }
      catch { serialized = '{"ok":false,"code":"serialize_failed"}' }
      status = 500
    }
    try {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(serialized)
    } catch (e: any) {
      this.log.warn(`response write failed: ${e?.message}`)
    }
  }

  // ---------------------------------------------------------------- jsonrpc

  private async dispatch (msg: any, registry: TabRegistry, reqId: number): Promise<any> {
    const reply = (result: any) => ({ jsonrpc: '2.0', id: msg?.id ?? null, result })
    const err = (code: number, message: string) =>
      ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } })

    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return err(-32600, 'invalid request')
    }

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: '2025-06-18',
        serverInfo: { name: pkg.name, version: pkg.version },
        capabilities: { tools: {} },
        instructions: SERVER_INSTRUCTIONS,
      })
    }
    // Any JSON-RPC notification (no `id`) — or anything in the notifications/*
    // namespace — must NOT produce a response per JSON-RPC 2.0 and MCP spec.
    if (msg.id === undefined || msg.method.startsWith('notifications/')) return null

    if (msg.method === 'tools/list') {
      return reply({ tools: this.toolList() })
    }

    if (msg.method === 'tools/call') {
      const name: string = msg.params?.name
      const args = msg.params?.arguments ?? {}
      try {
        if (name === 'list_tabs') return reply(await this.toolListTabs(registry, reqId))
        if (name === 'send_to_tab') return reply(await this.toolSend(registry, args, reqId))
        if (name === 'rename_tab') return reply(await this.toolRename(args, reqId))
        if (name === 'new_tab')    return reply(await this.toolNew(args, reqId))
        return err(-32601, `unknown tool: ${name}`)
      } catch (e: any) {
        this.log.error(`[#${reqId}] tool ${name} threw`, e)
        return reply({
          content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'internal', error: e?.message ?? String(e) }) }],
          isError: true,
        })
      }
    }

    return err(-32601, `unknown method: ${msg.method}`)
  }

  private toolList () {
    return [
      {
        name: 'list_tabs',
        description: 'List Tabby tabs in this window with running processes. Returns each tab\'s session id, title and process list.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'send_to_tab',
        description: 'Inject text into the target tab as if typed/pasted. Cross-window calls are not supported.',
        inputSchema: {
          type: 'object',
          required: ['tab_id', 'text'],
          additionalProperties: false,
          properties: {
            tab_id: { type: 'string', minLength: 1, maxLength: 128 },
            text:   { type: 'string', maxLength: MAX_TEXT_BYTES },
            submit: { type: 'boolean', default: true },
            mode:   { type: 'string', enum: ['auto', 'paste', 'keystrokes'], default: 'auto',
                    description: '"auto" (default) reads the target tab\'s bracketed-paste support from xterm.js and wraps only when supported. "paste" forces wrapping. "keystrokes" sends raw bytes.' },
          },
        },
      },
      {
        name: 'rename_tab',
        description: 'Set a custom name on the target tab. The name appears in list_tabs and in Tabby\'s tab header. Names must be unique across registered tabs (no two tabs can share the same custom name).',
        inputSchema: {
          type: 'object',
          required: ['tab_id', 'name'],
          additionalProperties: false,
          properties: {
            tab_id: { type: 'string', minLength: 1, maxLength: 128 },
            name:   { type: 'string', minLength: 1, maxLength: MAX_TAB_NAME_LEN },
          },
        },
      },
      {
        name: 'new_tab',
        description: `Open a new terminal tab in the current Tabby window. Optionally set its custom name in the same call. Refuses to create more than ${MAX_TABS} addressable tabs to prevent runaway creation. Returns once the new tab has a stable id.`,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: MAX_TAB_NAME_LEN,
                    description: 'Optional custom name to set on the new tab (subject to the same uniqueness rule as rename_tab).' },
          },
        },
      },
    ]
  }

  // ---------------------------------------------------------------- tools

  private async toolListTabs (registry: TabRegistry, reqId: number) {
    const tabs = await Promise.all(registry.list().map(async e => {
      let processes: RawProc[] = []
      let processes_error: string | undefined
      const session: any = e.tab.session
      if (typeof session?.getChildProcesses === 'function') {
        try {
          const raw: any[] = await this.withTimeout<any[]>(session.getChildProcesses(), CHILD_PROC_TIMEOUT_MS)
          const pids = raw.map((p: any) => Number(p.pid))
          const cmdlines = await readCmdlinesBounded(pids)
          processes = raw.map((p: any) => ({
            pid: Number(p.pid),
            ppid: Number(p.ppid),
            command: String(p.command ?? ''),
            cmdline: cmdlines.get(Number(p.pid)),
          }))
        } catch (err: any) {
          processes_error = err?.message ?? String(err)
          this.log.warn(`[#${reqId}] getChildProcesses(${e.id}) failed: ${processes_error}`)
        }
      }

      // On Windows, the Windows-side process tree dead-ends at wsl.exe for
      // WSL tabs. Cross the boundary by querying /proc inside WSL and
      // matching back to this tab via the injected TABBY_AGENT_CHAT_TAB_ID.
      // If the marker isn't found (non-WSL tab, or tab spawned before our
      // injector ran), the query returns empty and we keep the Windows-side
      // results.
      if (process.platform === 'win32') {
        try {
          const wslProcs = await queryWslProcessesByTabId(e.id, WSL_QUERY_TIMEOUT_MS)
          if (wslProcs.length > 0) {
            processes = wslProcs   // replace useless Windows-side helpers with the real WSL tree
          }
        } catch (err: any) {
          // Common: no WSL installed, or wsl.exe not on PATH — leave a soft
          // warning, don't fail the whole list_tabs call.
          this.log.warn(`[#${reqId}] wsl query for tab ${e.id} failed: ${err?.message}`)
        }
      }

      const customTitle = ((e.tab as any).customTitle as string | undefined) ?? ''
      const title = customTitle || (e.tab.title ?? '')
      return {
        id: e.id,
        title,                                                  // what the user sees in the tab header
        name: customTitle || undefined,                          // present only if a custom name was set
        processes,
        ...(processes_error ? { processes_error } : {}),
      }
    }))

    this.log.debug(`[#${reqId}] list_tabs returned ${tabs.length} tab(s)`)
    const result = { tabs }
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  }

  private async toolSend (registry: TabRegistry, args: any, reqId: number) {
    if (typeof args?.tab_id !== 'string' || !args.tab_id) {
      return this.toolErr('invalid_args', 'tab_id (string) is required')
    }
    if (typeof args.text !== 'string') {
      return this.toolErr('invalid_args', 'text (string) is required')
    }
    if (args.text.length > MAX_TEXT_BYTES) {
      return this.toolErr('invalid_args', `text exceeds ${MAX_TEXT_BYTES} chars`)
    }
    const submit: boolean = args.submit ?? true
    const reqMode: 'auto'|'paste'|'keystrokes' =
      args.mode === 'keystrokes' ? 'keystrokes'
        : args.mode === 'paste' ? 'paste'
        : 'auto'

    const entry = registry.get(args.tab_id)
    if (!entry) {
      const available = registry.list().map(e => e.id)
      this.log.warn(`[#${reqId}] send_to_tab: unknown id ${args.tab_id} (have: ${available.length})`)
      return this.toolErr('unknown_tab', `no tab with id ${args.tab_id}`, { available_ids: available })
    }
    if (!entry.tab.session) {
      return this.toolErr('tab_not_ready', `tab ${args.tab_id} has no active session`)
    }

    const fe: any = entry.tab.frontend
    const supportsBP = typeof fe?.supportsBracketedPaste === 'function'
      ? !!fe.supportsBracketedPaste()
      : false
    const useBrackets =
      reqMode === 'paste' ? true
        : reqMode === 'keystrokes' ? false
        : supportsBP   // auto
    const effectiveMode = useBrackets ? 'paste' : 'keystrokes'

    let payload = args.text
    if (useBrackets) payload = `\x1b[200~${payload}\x1b[201~`
    if (submit) payload += '\r'

    const buf = Buffer.from(payload, 'utf8')
    try {
      entry.tab.sendInput(buf)
    } catch (e: any) {
      this.log.error(`[#${reqId}] sendInput(${entry.id}) threw`, e)
      return this.toolErr('send_failed', e?.message ?? String(e))
    }

    this.log.info(`[#${reqId}] sent tab=${entry.id} mode=${reqMode}→${effectiveMode} (bp=${supportsBP}) submit=${submit} bytes=${buf.length}`)
    const result = { ok: true, tab_id: entry.id, bytes_sent: buf.length }
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  }

  private async toolRename (args: any, reqId: number) {
    if (typeof args?.tab_id !== 'string' || !args.tab_id) {
      return this.toolErr('invalid_args', 'tab_id (string) is required')
    }
    const v = validateTabName(args?.name)
    if (!v.ok) return this.toolErr(v.code, v.error)

    const registry = this.opts.registry
    const entry = registry.get(args.tab_id)
    if (!entry) {
      return this.toolErr('unknown_tab', `no tab with id ${args.tab_id}`, { available_ids: registry.list().map(e => e.id) })
    }

    // Uniqueness: another tab must not already have this customTitle.
    const dupe = registry.list().find(e => e.id !== entry.id && (e.tab as any).customTitle === v.name)
    if (dupe) {
      return this.toolErr('name_in_use', `name "${v.name}" already used by tab ${dupe.id}`, { conflicting_tab_id: dupe.id })
    }

    try {
      (entry.tab as any).setTitle?.(v.name)
      ;(entry.tab as any).customTitle = v.name
      this.opts.app.emitTabsChanged()
    } catch (e: any) {
      this.log.error(`[#${reqId}] rename failed`, e)
      return this.toolErr('internal', e?.message ?? String(e))
    }

    this.log.info(`[#${reqId}] renamed tab=${entry.id} name="${v.name}"`)
    const result = { ok: true, tab_id: entry.id, name: v.name }
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  }

  private async toolNew (args: any, reqId: number) {
    const registry = this.opts.registry
    const current = registry.list().length
    if (current >= MAX_TABS) {
      return this.toolErr('too_many_tabs', `tab cap reached (${current}/${MAX_TABS}); refusing to open new tab`)
    }

    // Validate the name shape (uniqueness is re-checked AFTER the tab is
    // registered to close the race window between concurrent new_tab calls).
    let validatedName: string | undefined
    if (args?.name !== undefined) {
      const v = validateTabName(args.name)
      if (!v.ok) return this.toolErr(v.code, v.error)
      validatedName = v.name
    }

    // Pick a local profile (SSH/serial/telnet aren't addressable by this plugin).
    let profile: any
    try {
      const all = await this.opts.profiles.getProfiles()
      profile = all.find((p: any) => p.type === 'local')
      if (!profile) return this.toolErr('no_local_profile', 'no local profile configured in Tabby')
    } catch (e: any) {
      this.log.error(`[#${reqId}] new_tab: getProfiles failed`, e)
      return this.toolErr('internal', e?.message ?? String(e))
    }

    let wrapper: any
    try {
      wrapper = await this.opts.profiles.openNewTabForProfile(profile)
      if (!wrapper) return this.toolErr('open_failed', 'openNewTabForProfile returned null')
    } catch (e: any) {
      this.log.error(`[#${reqId}] new_tab: openNewTabForProfile failed`, e)
      return this.toolErr('internal', e?.message ?? String(e))
    }

    // Wait for OUR wrapper's child to register. Matching by component reference
    // (not by "first id we haven't seen") so concurrent new_tab calls don't
    // cross-latch onto each other's tabs.
    const newId = await this.waitForWrapperRegistered(wrapper, NEW_TAB_WAIT_MS)
    if (!newId) {
      return this.toolErr('register_timeout', `new tab did not register within ${NEW_TAB_WAIT_MS}ms`)
    }
    const entry = registry.get(newId)
    if (!entry) {
      // Should not happen — registered then immediately disappeared.
      return this.toolErr('internal', `tab ${newId} disappeared after registration`)
    }

    if (validatedName) {
      // Re-check uniqueness now, since other concurrent callers may have
      // claimed the name between our up-front check and this point.
      const dupe = registry.list().find(e => e.id !== newId && (e.tab as any).customTitle === validatedName)
      if (dupe) {
        // Close the tab we just opened so a name conflict doesn't leave
        // an orphan unnamed tab behind. app.closeTab needs the top-level
        // entry from app.tabs (often a SplitTabComponent wrapper), not the
        // inner terminal.
        const topLevel = this.opts.app.tabs.find(t => t === entry.tab) ?? (entry.tab as any).parent ?? entry.tab
        try { await this.opts.app.closeTab(topLevel as any, false) }
        catch (e: any) { this.log.warn(`[#${reqId}] new_tab: closeTab after conflict failed: ${e?.message}`) }
        return this.toolErr('name_in_use', `name "${validatedName}" already used by tab ${dupe.id}`, { conflicting_tab_id: dupe.id })
      }
      try {
        (entry.tab as any).setTitle?.(validatedName)
        ;(entry.tab as any).customTitle = validatedName
        this.opts.app.emitTabsChanged()
      } catch (e: any) {
        this.log.warn(`[#${reqId}] new_tab: rename after open failed: ${e?.message}`)
      }
    }

    this.log.info(`[#${reqId}] new_tab id=${newId}${validatedName ? ` name="${validatedName}"` : ''}`)
    const result = { ok: true, tab_id: newId, name: validatedName }
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  }

  private async waitForWrapperRegistered (wrapper: any, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const candidates: any[] = typeof wrapper?.getAllTabs === 'function'
        ? wrapper.getAllTabs()
        : [wrapper]
      for (const c of candidates) {
        for (const e of this.opts.registry.list()) {
          if (e.tab === c) return e.id
        }
      }
      await new Promise(r => setTimeout(r, 100))
    }
    return null
  }

  private toolErr (code: string, message: string, extra?: Record<string, any>) {
    const body = { ok: false, code, error: message, ...(extra ?? {}) }
    return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true }
  }

  // ---------------------------------------------------------------- utils

  // NB: on timeout the underlying promise is abandoned, not cancelled — the
  // platform getChildProcesses() implementations have no AbortSignal support.
  // Late rejection lands on the already-settled deferred (harmless).
  private withTimeout<T> (p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
    })
  }

}
