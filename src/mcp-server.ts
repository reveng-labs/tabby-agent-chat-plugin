import { Injectable, NgZone } from '@angular/core'
import { Server, Socket, createServer } from 'net'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { AppService, LogService, Logger, ProfilesService } from 'tabby-core'
import { TabRegistry, TAB_ID_ENV_KEY } from './tab-registry'
import { RawProc } from './process-tree'
import { getSocketPath } from './socket-path'
import {
  pipeLines, writeJson,
  FollowerEvent, FollowerTabInfo,
  LeaderRpcRequest, LeaderRpcResponse,
  isFollowerEvent, isLeaderRpcResponse,
} from './wire'
import {
  MAX_TABS, MAX_TEXT_BYTES, MAX_TAB_NAME_LEN,
  listTabProcessesFull, getTabName, isWslTab,
  sendToTabLocal, renameTabLocal, newTabLocal,
  toolError, ToolError,
} from './tab-actions'
import pkg from '../package.json'

const FOLLOWER_RPC_TIMEOUT_MS = 30000

const SERVER_INSTRUCTIONS = `This server exposes terminal tabs in the current Tabby window for
agent-to-agent messaging.

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

export interface LeaderStartOptions {
  registry: TabRegistry
  logSvc: LogService
  app: AppService
  profiles: ProfilesService
  zone: NgZone
}

interface FollowerConn {
  windowId: number
  sock: Socket
  // tabId → cached info, kept up-to-date by tab_added/tab_removed/tab_renamed events
  tabs: Map<string, FollowerTabInfo>
  // pending RPCs awaiting a response from this follower
  pending: Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }>
}

@Injectable({ providedIn: 'root' })
export class LeaderServer {
  private srv?: Server
  private log!: Logger
  private opts!: LeaderStartOptions
  private reqSeq = 0
  private starting?: Promise<void>
  private followers = new Map<number, FollowerConn>()

  async start (opts: LeaderStartOptions): Promise<void> {
    if (this.srv) return
    if (this.starting) return this.starting
    this.starting = this._start(opts)
    try { await this.starting } finally { this.starting = undefined }
  }

  private async _start (opts: LeaderStartOptions) {
    this.opts = opts
    this.log = opts.logSvc.create('agent-chat:leader')

    const sockPath = getSocketPath()
    // Clean stale socket from a previous crash. On Windows named pipes, this
    // unlink is a no-op (they auto-cleanup on process exit and the path isn't
    // a filesystem entry anyway).
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
    this.log.info(`leader listening on ${sockPath}`)
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
    for (const f of this.followers.values()) {
      try { f.sock.destroy() } catch { /* gone */ }
    }
    this.followers.clear()
    const srv = this.srv
    this.srv = undefined
    await new Promise<void>(resolve => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      try { srv.close(finish) } catch { finish() }
      setTimeout(finish, 2000).unref?.()
    })
  }

  // ---------------------------------------------------------------- connections

  private onConnection (sock: Socket) {
    let classified = false
    let follower: FollowerConn | undefined

    const handleLine = (line: string) => {
      let msg: any
      try { msg = JSON.parse(line) }
      catch { this.log.warn(`bad json from client: ${line.slice(0, 80)}…`); return }

      if (!classified) {
        classified = true
        // First message classifies the connection. follower-hello → follower.
        // Anything else is MCP JSON-RPC from a shim.
        if (isFollowerEvent(msg) && msg._event === 'hello' && typeof msg.windowId === 'number') {
          follower = this.attachFollower(sock, msg.windowId, msg.tabs ?? [])
          // hello processed; nothing more to do for this line
          return
        }
        // Fall through to MCP handling
      }
      if (follower) {
        this.handleFollowerMessage(follower, msg)
        return
      }
      // MCP client (shim) path
      this.handleMcpMessage(sock, msg).catch(e => this.log.error('mcp dispatch crashed', e))
    }

    pipeLines(sock, handleLine)
    sock.on('error', e => this.log.warn(`client socket error: ${e.message}`))
    sock.on('close', () => {
      if (follower) this.detachFollower(follower)
    })
  }

  private attachFollower (sock: Socket, windowId: number, tabs: FollowerTabInfo[]): FollowerConn {
    // If the same window reconnects (e.g. flaky transport), boot the old one.
    const existing = this.followers.get(windowId)
    if (existing) {
      this.log.warn(`follower window=${windowId} reconnected; dropping old connection`)
      try { existing.sock.destroy() } catch { /* gone */ }
      this.followers.delete(windowId)
    }
    const f: FollowerConn = {
      windowId,
      sock,
      tabs: new Map(tabs.map(t => [t.id, t])),
      pending: new Map(),
    }
    this.followers.set(windowId, f)
    this.log.info(`follower attached: window=${windowId} tabs=${f.tabs.size}`)
    return f
  }

  private detachFollower (f: FollowerConn) {
    this.followers.delete(f.windowId)
    for (const p of f.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(`follower window=${f.windowId} disconnected`))
    }
    f.pending.clear()
    this.log.info(`follower detached: window=${f.windowId}`)
  }

  private handleFollowerMessage (f: FollowerConn, msg: any) {
    if (isLeaderRpcResponse(msg)) {
      const pending = f.pending.get(msg._rpcId)
      if (!pending) {
        this.log.warn(`stray rpc response from window=${f.windowId} id=${msg._rpcId}`)
        return
      }
      f.pending.delete(msg._rpcId)
      clearTimeout(pending.timer)
      if (msg._error) pending.reject(new Error(`[${msg._error.code}] ${msg._error.message}`))
      else pending.resolve(msg._result)
      return
    }
    if (isFollowerEvent(msg)) {
      switch (msg._event) {
        case 'tab_added': f.tabs.set(msg.tab.id, msg.tab); break
        case 'tab_removed': f.tabs.delete(msg.tabId); break
        case 'tab_renamed': {
          const t = f.tabs.get(msg.tabId)
          if (t) t.name = msg.name
          break
        }
        // 'hello' shouldn't arrive again on an attached follower — ignore.
      }
      return
    }
    this.log.warn(`unrecognized message from follower window=${f.windowId}`)
  }

  private rpcFollower (f: FollowerConn, req: Omit<LeaderRpcRequest, '_rpcId'>): Promise<any> {
    return new Promise((resolve, reject) => {
      const _rpcId = randomUUID()
      const timer = setTimeout(() => {
        if (f.pending.delete(_rpcId)) reject(new Error(`rpc ${req._rpc} to window=${f.windowId} timed out`))
      }, FOLLOWER_RPC_TIMEOUT_MS)
      timer.unref?.()
      f.pending.set(_rpcId, { resolve, reject, timer })
      const ok = writeJson(f.sock, { ...req, _rpcId })
      if (!ok) {
        clearTimeout(timer)
        f.pending.delete(_rpcId)
        reject(new Error(`failed to write rpc to follower window=${f.windowId}`))
      }
    })
  }

  // ---------------------------------------------------------------- MCP

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
        description: 'List Tabby tabs across all windows of the same process with running processes. Returns each tab\'s id (always present — use with send_to_tab/rename_tab), name (the explicitly-set custom name, or null if none), processes, and the window it belongs to.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'send_to_tab',
        description: 'Inject text into the target tab as if typed/pasted. Works across windows.',
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
        description: 'Set a custom name on the target tab. Names must be unique across all addressable tabs.',
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
        description: `Open a new local terminal tab in the leader (main) Tabby window. Refuses to create more than ${MAX_TABS} addressable tabs total across all windows. Optionally sets a custom name in the same call.`,
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
    // Local tabs from the leader window
    const localPromises = this.opts.registry.list().map(async e => {
      const procRes = await listTabProcessesFull(e.tab, e.id)
      return {
        id: e.id,
        name: getTabName(e.tab),
        window: 0,
        processes: procRes.processes,
        ...(procRes.error ? { processes_error: procRes.error } : {}),
      }
    })

    // Follower tabs — fetch processes from each follower in parallel
    const remotePromises: Array<Promise<any>> = []
    for (const f of this.followers.values()) {
      for (const t of f.tabs.values()) {
        remotePromises.push(this.fetchFollowerTabRow(f, t))
      }
    }

    const all = await Promise.all([...localPromises, ...remotePromises])
    this.log.debug(`[#${reqId}] list_tabs returned ${all.length} tab(s) across ${this.followers.size + 1} window(s)`)
    const result = { tabs: all }
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  }

  private async fetchFollowerTabRow (f: FollowerConn, t: FollowerTabInfo) {
    try {
      const res = await this.rpcFollower(f, { _rpc: 'list_tab_processes', tabId: t.id })
      return {
        id: t.id,
        name: t.name,
        window: f.windowId,
        processes: (res?.processes as RawProc[]) ?? [],
        ...(res?.error ? { processes_error: res.error } : {}),
      }
    } catch (e: any) {
      return {
        id: t.id,
        name: t.name,
        window: f.windowId,
        processes: [],
        processes_error: e?.message ?? String(e),
      }
    }
  }

  private async toolSend (args: any, reqId: number) {
    const tabId = args?.tab_id
    if (typeof tabId !== 'string' || !tabId) {
      return this.wrap(toolError('invalid_args', 'tab_id (string) is required'))
    }
    // local?
    if (this.opts.registry.get(tabId)) {
      const res = await sendToTabLocal(this.opts.registry, this.opts.app, this.opts.zone, args, this.log, reqId)
      return this.wrap(res)
    }
    // remote?
    const owner = this.findFollowerForTab(tabId)
    if (owner) {
      try {
        const res = await this.rpcFollower(owner, { _rpc: 'send_to_tab', tabId, args })
        return this.wrap(res)
      } catch (e: any) {
        return this.wrap(toolError('rpc_failed', e?.message ?? String(e)))
      }
    }
    return this.wrap(toolError('unknown_tab', `no tab with id ${tabId}`, { available_ids: this.allTabIds() }))
  }

  private async toolRename (args: any, reqId: number) {
    const tabId = args?.tab_id
    if (typeof tabId !== 'string' || !tabId) {
      return this.wrap(toolError('invalid_args', 'tab_id (string) is required'))
    }
    // Compute known names across all windows (excluding target tab)
    const known = this.allTabNames(tabId)
    if (this.opts.registry.get(tabId)) {
      const res = renameTabLocal(this.opts.registry, this.opts.app, args, known, this.log, reqId)
      return this.wrap(res)
    }
    const owner = this.findFollowerForTab(tabId)
    if (owner) {
      try {
        const res = await this.rpcFollower(owner, { _rpc: 'rename_tab', tabId, args, knownNames: [...known] })
        // Update our cached name on success
        if (res?.ok) {
          const t = owner.tabs.get(tabId)
          if (t) t.name = res.name
        }
        return this.wrap(res)
      } catch (e: any) {
        return this.wrap(toolError('rpc_failed', e?.message ?? String(e)))
      }
    }
    return this.wrap(toolError('unknown_tab', `no tab with id ${tabId}`, { available_ids: this.allTabIds() }))
  }

  private async toolNew (args: any, reqId: number) {
    const known = this.allTabNames()
    const total = this.totalTabCount()
    const res = await newTabLocal(this.opts.registry, this.opts.app, this.opts.profiles, args ?? {}, known, total, this.log, reqId)
    return this.wrap(res)
  }

  private allTabIds (): string[] {
    const ids: string[] = this.opts.registry.list().map(e => e.id)
    for (const f of this.followers.values()) for (const t of f.tabs.values()) ids.push(t.id)
    return ids
  }

  private allTabNames (excludeTabId?: string): Set<string> {
    const names = new Set<string>()
    for (const e of this.opts.registry.list()) {
      if (e.id === excludeTabId) continue
      const n = getTabName(e.tab)
      if (n) names.add(n)
    }
    for (const f of this.followers.values()) {
      for (const t of f.tabs.values()) {
        if (t.id === excludeTabId) continue
        if (t.name) names.add(t.name)
      }
    }
    return names
  }

  private totalTabCount (): number {
    let n = this.opts.registry.list().length
    for (const f of this.followers.values()) n += f.tabs.size
    return n
  }

  private findFollowerForTab (tabId: string): FollowerConn | undefined {
    for (const f of this.followers.values()) {
      if (f.tabs.has(tabId)) return f
    }
    return undefined
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
