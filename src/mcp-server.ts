import { Injectable, NgZone } from '@angular/core'
import { Server, Socket, createServer } from 'net'
import { promises as fs } from 'fs'
import { AppService, LogService, Logger, ProfilesService } from 'tabby-core'
import { TabRegistry } from './tab-registry'
import { getOrAllocateSocketPath } from './socket-path'
import { pipeLines, writeJson } from './wire'
import {
  MAX_TABS, MAX_TEXT_BYTES, MAX_TAB_NAME_LEN,
  listTabProcessesFull, getTabName,
  sendToTabLocal, renameTabLocal, newTabLocal,
  toolError,
} from './tab-actions'
import pkg from '../package.json'

const SERVER_INSTRUCTIONS = `This server exposes terminal tabs in the current Tabby window for
agent-to-agent messaging. Tabs in other windows are NOT addressable —
each Tabby window has its own independent MCP server.

WORKFLOW:
1. Call list_tabs → each tab has id, name, and processes (with cmdline).
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

export interface McpServerStartOptions {
  registry: TabRegistry
  logSvc: LogService
  app: AppService
  profiles: ProfilesService
  zone: NgZone
  windowId: number
}

@Injectable({ providedIn: 'root' })
export class McpServer {
  private srv?: Server
  private log!: Logger
  private opts!: McpServerStartOptions
  private reqSeq = 0
  private starting?: Promise<void>

  async start (opts: McpServerStartOptions): Promise<void> {
    if (this.srv) return
    if (this.starting) return this.starting
    this.starting = this._start(opts)
    try { await this.starting } finally { this.starting = undefined }
  }

  private async _start (opts: McpServerStartOptions) {
    this.opts = opts
    this.log = opts.logSvc.create('agent-chat:server')

    const sockPath = getOrAllocateSocketPath()
    // Clean stale socket from a previous crash. Random per-window paths make
    // this almost never necessary, but a test override pointing at a fixed
    // path benefits from it. No-op for Windows named pipes.
    if (process.platform !== 'win32') {
      try { await fs.unlink(sockPath) } catch { /* didn't exist, or no perms — listen will surface the real error */ }
    }

    const srv = createServer(sock => this.onConnection(sock))
    srv.on('error', err => this.log.error('uds server error', err))

    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => { srv.off('listening', onListen); reject(e) }
      const onListen = () => { srv.off('error', onError); resolve() }
      srv.once('error', onError)
      srv.once('listening', onListen)
      srv.listen(sockPath)
    })

    this.srv = srv
    this.log.info(`listening on ${sockPath} (window=${opts.windowId})`)
    this.installShutdownHooks()
  }

  private installShutdownHooks () {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => { void this.stop() })
    }
  }

  async stop () {
    if (!this.srv) return
    this.log.info('stopping uds server')
    const srv = this.srv
    this.srv = undefined
    await new Promise<void>(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      try { srv.close(finish) } catch { finish() }
      setTimeout(finish, 2000).unref?.()
    })
  }

  // ---------------------------------------------------------------- MCP

  private onConnection (sock: Socket) {
    pipeLines(sock, line => {
      let msg: any
      try { msg = JSON.parse(line) }
      catch { this.log.warn(`bad json from client: ${line.slice(0, 80)}…`); return }
      this.handleMcpMessage(sock, msg).catch(e => this.log.error('mcp dispatch crashed', e))
    })
    sock.on('error', e => this.log.warn(`client socket error: ${e.message}`))
  }

  private async handleMcpMessage (sock: Socket, msg: any) {
    const reqId = ++this.reqSeq
    const reply = (result: any) => writeJson(sock, { jsonrpc: '2.0', id: msg?.id ?? null, result })
    const err = (code: number, message: string) =>
      writeJson(sock, { jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } })

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
    if (msg.id === undefined || msg.method.startsWith('notifications/')) return

    if (msg.method === 'tools/list') {
      return reply({ tools: this.toolList() })
    }

    if (msg.method === 'tools/call') {
      const name: string = msg.params?.name
      const args = msg.params?.arguments ?? {}
      try {
        if (name === 'list_tabs') return reply(await this.toolListTabs(reqId))
        if (name === 'send_to_tab') return reply(await this.toolSend(args, reqId))
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
        description: 'List Tabby tabs in the current window with running processes. Returns each tab\'s id (always present — use with send_to_tab/rename_tab), name (the explicitly-set custom name, or null if none), and processes. Tabs in other Tabby windows are not visible — each window has its own MCP server.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'send_to_tab',
        description: 'Inject text into the target tab as if typed/pasted. The target must be in the same window.',
        inputSchema: {
          type: 'object',
          required: ['tab_id', 'text'],
          additionalProperties: false,
          properties: {
            tab_id: { type: 'string', minLength: 1, maxLength: 128 },
            text:   { type: 'string', maxLength: MAX_TEXT_BYTES },
            submit: { type: 'boolean', default: true },
            mode:   { type: 'string', enum: ['auto', 'paste', 'keystrokes'], default: 'auto',
                    description: '"auto" (default) wraps in bracketed-paste when the target tab supports it. "paste" forces wrapping. "keystrokes" sends raw bytes.' },
          },
        },
      },
      {
        name: 'rename_tab',
        description: 'Set a custom name on the target tab. Names must be unique within this window.',
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
        description: `Open a new local terminal tab in the current Tabby window. Refuses to create more than ${MAX_TABS} addressable tabs in this window. Optionally sets a custom name in the same call.`,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: MAX_TAB_NAME_LEN,
                    description: 'Optional custom name to set on the new tab.' },
          },
        },
      },
    ]
  }

  // ---------------------------------------------------------------- tools

  private async toolListTabs (reqId: number) {
    const tabs = await Promise.all(this.opts.registry.list().map(async e => {
      const procRes = await listTabProcessesFull(e.tab, e.id)
      return {
        id: e.id,
        name: getTabName(e.tab),
        processes: procRes.processes,
        ...(procRes.error ? { processes_error: procRes.error } : {}),
      }
    }))
    this.log.debug(`[#${reqId}] list_tabs returned ${tabs.length} tab(s)`)
    const result = { tabs }
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  }

  private async toolSend (args: any, reqId: number) {
    const tabId = args?.tab_id
    if (typeof tabId !== 'string' || !tabId) {
      return this.wrap(toolError('invalid_args', 'tab_id (string) is required'))
    }
    if (!this.opts.registry.get(tabId)) {
      return this.wrap(toolError('unknown_tab', `no tab with id ${tabId}`, { available_ids: this.opts.registry.list().map(e => e.id) }))
    }
    const res = await sendToTabLocal(this.opts.registry, this.opts.app, this.opts.zone, args, this.log, reqId)
    return this.wrap(res)
  }

  private async toolRename (args: any, reqId: number) {
    const tabId = args?.tab_id
    if (typeof tabId !== 'string' || !tabId) {
      return this.wrap(toolError('invalid_args', 'tab_id (string) is required'))
    }
    if (!this.opts.registry.get(tabId)) {
      return this.wrap(toolError('unknown_tab', `no tab with id ${tabId}`, { available_ids: this.opts.registry.list().map(e => e.id) }))
    }
    const known = this.localTabNames(tabId)
    const res = renameTabLocal(this.opts.registry, this.opts.app, args, known, this.log, reqId)
    return this.wrap(res)
  }

  private async toolNew (args: any, reqId: number) {
    const known = this.localTabNames()
    const count = this.opts.registry.list().length
    const res = await newTabLocal(this.opts.registry, this.opts.app, this.opts.profiles, args ?? {}, known, count, this.log, reqId)
    return this.wrap(res)
  }

  private localTabNames (excludeTabId?: string): Set<string> {
    const names = new Set<string>()
    for (const e of this.opts.registry.list()) {
      if (e.id === excludeTabId) continue
      const n = getTabName(e.tab)
      if (n) names.add(n)
    }
    return names
  }

  // Wrap a tool result so MCP shapes are consistent: structuredContent +
  // content-text. Errors become { isError: true } per MCP convention.
  private wrap (res: any) {
    if (res && res.ok === false) {
      return { content: [{ type: 'text', text: JSON.stringify(res) }], isError: true }
    }
    return { structuredContent: res, content: [{ type: 'text', text: JSON.stringify(res) }] }
  }
}
