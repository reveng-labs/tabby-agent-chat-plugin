import { Injectable } from '@angular/core'
import { AddressInfo } from 'net'
import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { promises as fs, unlinkSync } from 'fs'
import { homedir } from 'os'
import * as path from 'path'
import { LogService, Logger } from 'tabby-core'
import { TabRegistry } from './tab-registry'

const MAX_BODY_BYTES = 1024 * 1024              // 1 MB hard cap
const MAX_TEXT_BYTES = 64 * 1024                // per send_to_tab payload
const CHILD_PROC_TIMEOUT_MS = 1000              // bound list_tabs latency
const DISCOVERY_FILE = path.join(homedir(), '.config', 'tabby', 'agent-chat.json')
const INSTALL_FILE = path.join(homedir(), '.config', 'tabby', 'agent-chat-INSTALL.md')

const INSTALL_MD = `# tabby-agent-chat — install and usage

This file is auto-written by the Tabby plugin "tabby-agent-chat" at
startup. Path is exported as TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS so any
AI agent running in a Tabby tab can locate it.

## What is this

An MCP (Model Context Protocol) server that lets one AI agent (Claude
Code, Codex, etc.) send messages to other AI agents running in other
terminal tabs of the same Tabby window. Useful for orchestrating
multi-agent workflows.

The server is HTTP, bound to 127.0.0.1 only, auth via a per-window
bearer token. Connection info is in these env vars (present in any
shell spawned inside Tabby after the plugin loads):

  TABBY_AGENT_CHAT_URL    full http://127.0.0.1:PORT/mcp URL
  TABBY_AGENT_CHAT_TOKEN  bearer token

The same info is also in ~/.config/tabby/agent-chat.json.

## Installation

Run the command for whichever agent CLI you're using. Both commands use
\${VAR} so the connection info is resolved by the agent itself at
connect time — not baked into the config file. This means the same
config keeps working across Tabby restarts (the port and token change
each run).

### Claude Code

    claude mcp add --transport http --scope user tabby-agent-chat \\
      '\${TABBY_AGENT_CHAT_URL}' \\
      --header 'Authorization: Bearer \${TABBY_AGENT_CHAT_TOKEN}'

### Codex

    codex mcp add tabby-agent-chat \\
      --url "$TABBY_AGENT_CHAT_URL" \\
      --bearer-token-env-var TABBY_AGENT_CHAT_TOKEN

NOTE: Codex stores --url as a literal value; on Tabby restart the URL
goes stale (new port). Re-run the command after each Tabby restart, or
edit ~/.codex/config.toml to use a stable port if you want a one-time
setup. Token rotation is handled because --bearer-token-env-var is read
at runtime.

## Tools exposed by this MCP server

* list_tabs — returns every terminal tab in the current Tabby window.
  Each entry has:
    - id        stable string id for the tab (use with send_to_tab)
    - title     human-readable tab title
    - processes [{pid, ppid, command, cmdline?}] — the process tree
                running in the tab. cmdline reveals which agent is
                running (e.g. "node …/codex", "claude")

* send_to_tab(tab_id, text, [submit=true], [mode="auto"]) — inject text
  into the target tab's stdin. The receiving program cannot distinguish
  this from typed/pasted input.
    - mode="auto"      (default) reads xterm.js's bracketed-paste flag
                       and wraps only when the target supports it
    - mode="paste"     forces bracketed-paste wrapping
    - mode="keystrokes" sends raw bytes for control sequences
                        (e.g. text="\\x03" for Ctrl-C)
    - submit=true (default) appends \\r so the line is "entered"

## Typical use case

User asks one agent: "send X to the agent doing Y".

1. Agent calls list_tabs, inspects each tab's processes/cmdline to
   identify which tabs contain which agents.
2. To find which one is working on Y, the agent reads the target
   agent's transcript from its own on-disk store:
     Claude Code: ~/.claude/projects/<slug>/...
     Codex:       ~/.codex/sessions/<id>/...
3. Agent calls send_to_tab(tab_id, "X") to deliver the message.

## Limitations

- Only local terminal tabs are addressable. SSH / serial / telnet tabs
  do not expose a tab id and won't appear in list_tabs.
- Each Tabby window runs its own MCP server. Cross-window messaging is
  not supported.
- Shells opened before the plugin loaded won't have the env vars; close
  and reopen the tab to fix.
`

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

@Injectable({ providedIn: 'root' })
export class McpServer {
  private srv?: Server
  private port = 0
  private token = randomUUID()
  private log!: Logger
  private reqSeq = 0
  private starting?: Promise<void>
  private exitHandler?: () => void

  async start (registry: TabRegistry, logSvc: LogService): Promise<void> {
    // Protect against concurrent or repeated calls: both same-tick callers
    // share the same in-flight promise; later callers see this.srv already set.
    if (this.srv) return
    if (this.starting) return this.starting
    this.starting = this._start(registry, logSvc)
    try { await this.starting } finally { this.starting = undefined }
  }

  private async _start (registry: TabRegistry, logSvc: LogService) {
    this.log = logSvc.create('agent-chat')

    const srv = createServer((req, res) => {
      this.safeHandle(req, res, registry).catch(err => {
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
    this.log.info(`listening on http://127.0.0.1:${this.port} (token hidden; see ${DISCOVERY_FILE})`)

    // Inject discovery vars into the renderer's env so every shell Tabby
    // spawns afterwards inherits them. Existing shells were spawned with
    // the old env (or none) and won't see this until restarted.
    process.env.TABBY_AGENT_CHAT_URL = `http://127.0.0.1:${this.port}/mcp`
    process.env.TABBY_AGENT_CHAT_TOKEN = this.token
    process.env.TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS = INSTALL_FILE
    this.log.info(`exported TABBY_AGENT_CHAT_URL, _TOKEN, _INSTALL_INSTRUCTIONS to renderer env`)

    await this.writeDiscoveryFile()
    await this.writeInstallFile()
    this.installShutdownHooks()
  }

  private installShutdownHooks () {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        // Sync cleanup first — async stop() may not finish before renderer exits.
        this.unlinkDiscoverySync()
        void this.stop()
      })
    }
    try {
      this.exitHandler = () => this.unlinkDiscoverySync()
      process.once('exit', this.exitHandler)
    } catch { /* not a Node-integrated context */ }
  }

  private unlinkDiscoverySync () {
    try { unlinkSync(DISCOVERY_FILE) }
    catch (e: any) {
      if (e?.code !== 'ENOENT') this.log?.warn?.(`unlinkSync(discovery): ${e?.message}`)
    }
  }

  async stop () {
    if (!this.srv) return
    this.log.info('stopping http server')
    delete process.env.TABBY_AGENT_CHAT_URL
    delete process.env.TABBY_AGENT_CHAT_TOKEN
    delete process.env.TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS
    try { await fs.unlink(DISCOVERY_FILE) }
    catch (e: any) { if (e?.code !== 'ENOENT') this.log.warn(`unlink(discovery): ${e?.message}`) }
    try { await fs.unlink(INSTALL_FILE) }
    catch (e: any) { if (e?.code !== 'ENOENT') this.log.warn(`unlink(install): ${e?.message}`) }
    if (this.exitHandler) {
      try { process.removeListener('exit', this.exitHandler) } catch { /* not a Node context */ }
      this.exitHandler = undefined
    }
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
        serverInfo: { name: 'tabby-agent-chat', version: '0.1.0' },
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
      return { id: e.id, title: e.tab.title, processes, ...(processes_error ? { processes_error } : {}) }
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

  private async writeInstallFile () {
    try {
      await fs.mkdir(path.dirname(INSTALL_FILE), { recursive: true })
      await fs.writeFile(INSTALL_FILE, INSTALL_MD, { mode: 0o644 })
      this.log.info(`install instructions at ${INSTALL_FILE}`)
    } catch (e: any) {
      this.log.warn(`could not write install file: ${e?.message}`)
    }
  }

  private async writeDiscoveryFile () {
    try {
      await fs.mkdir(path.dirname(DISCOVERY_FILE), { recursive: true })
      // unlink first: fs.writeFile honours `mode` only on file creation,
      // so a pre-existing 0644 (e.g., from a foreign-uid prior run) would
      // not be tightened. Removing-then-writing guarantees 0600.
      try { await fs.unlink(DISCOVERY_FILE) }
      catch (e: any) {
        if (e?.code !== 'ENOENT') this.log.warn(`pre-write unlink: ${e?.message}`)
      }
      const payload = JSON.stringify({
        pid: process.pid,
        port: this.port,
        token: this.token,
        url: `http://127.0.0.1:${this.port}/mcp`,
      }, null, 2)
      await fs.writeFile(DISCOVERY_FILE, payload, { mode: 0o600 })
      this.log.info(`discovery file at ${DISCOVERY_FILE} (mode 0600)`)
    } catch (e: any) {
      this.log.warn(`could not write discovery file: ${e?.message}`)
    }
  }
}
