import { Injectable } from '@angular/core'
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
const DISCOVERY_FILE = path.join(homedir(), '.config', 'tabby', 'input-broker.json')

interface RawProc { pid: number; ppid: number; command: string }

@Injectable({ providedIn: 'root' })
export class McpServer {
  private srv?: Server
  private port = 0
  private token = randomUUID()
  private log!: Logger
  private reqSeq = 0

  async start (registry: TabRegistry, logSvc: LogService) {
    this.log = logSvc.create('input-broker')

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

    this.srv = srv
    this.port = (srv.address() as any).port
    this.log.info(`listening on http://127.0.0.1:${this.port} (token hidden; see ${DISCOVERY_FILE})`)

    await this.writeDiscoveryFile()
    this.installShutdownHooks()
  }

  private installShutdownHooks () {
    // Renderer close / reload: initiate async stop() but don't block teardown.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => { void this.stop() })
    }
    // Last-resort sync cleanup on hard process exit (async handlers won't run here).
    try {
      process.on('exit', () => {
        try { unlinkSync(DISCOVERY_FILE) } catch { /* already gone */ }
      })
    } catch { /* not a Node-integrated context */ }
  }

  async stop () {
    if (!this.srv) return
    this.log.info('stopping http server')
    try { await fs.unlink(DISCOVERY_FILE) } catch { /* file may not exist */ }
    const srv = this.srv
    this.srv = undefined
    // Drop keep-alives first so close() can resolve even if a handler held a socket open.
    try { (srv as any).closeAllConnections?.() } catch { /* nothing to do */ }
    await new Promise<void>(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      srv.close(() => finish())
      // Hard cap: don't let a hung handler block shutdown forever.
      setTimeout(finish, 2000).unref?.()
    })
  }

  // ---------------------------------------------------------------- transport

  private async safeHandle (req: IncomingMessage, res: ServerResponse, registry: TabRegistry) {
    const reqId = ++this.reqSeq
    const t0 = Date.now()
    const remote = req.socket.remoteAddress ?? '?'

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

      let msg: any
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
      this.tryWrite(res, 500, { ok: false, code: 'internal', error: e?.message ?? String(e) })
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
      req.on('aborted', () => fail(new Error('aborted')))
    })
  }

  private tryWrite (res: ServerResponse, status: number, body: any) {
    if (res.writableEnded || res.headersSent) return
    try {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
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
        serverInfo: { name: 'tabby-input-broker', version: '0.1.0' },
        capabilities: { tools: {} },
      })
    }
    if (msg.method === 'notifications/initialized') return null

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
            mode:   { type: 'string', enum: ['paste', 'keystrokes'], default: 'paste' },
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
          processes = await this.withTimeout(session.getChildProcesses(), CHILD_PROC_TIMEOUT_MS)
          processes = processes.map(p => ({
            pid: Number(p.pid),
            ppid: Number(p.ppid),
            command: String(p.command ?? ''),
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
    const mode: 'paste'|'keystrokes' = args.mode === 'keystrokes' ? 'keystrokes' : 'paste'

    const entry = registry.get(args.tab_id)
    if (!entry) {
      const available = registry.list().map(e => e.id)
      this.log.warn(`[#${reqId}] send_to_tab: unknown id ${args.tab_id} (have: ${available.length})`)
      return this.toolErr('unknown_tab', `no tab with id ${args.tab_id}`, { available_ids: available })
    }
    if (!entry.tab.session) {
      return this.toolErr('tab_not_ready', `tab ${args.tab_id} has no active session`)
    }

    let payload = args.text
    if (mode === 'paste') payload = `\x1b[200~${payload}\x1b[201~`
    if (submit) payload += '\r'

    const buf = Buffer.from(payload, 'utf8')
    try {
      entry.tab.sendInput(buf)
    } catch (e: any) {
      this.log.error(`[#${reqId}] sendInput(${entry.id}) threw`, e)
      return this.toolErr('send_failed', e?.message ?? String(e))
    }

    this.log.info(`[#${reqId}] sent tab=${entry.id} mode=${mode} submit=${submit} bytes=${buf.length}`)
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

  private async writeDiscoveryFile () {
    try {
      await fs.mkdir(path.dirname(DISCOVERY_FILE), { recursive: true })
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
