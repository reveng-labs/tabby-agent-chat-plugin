import { Injectable, NgZone } from '@angular/core'
import { Socket, createConnection } from 'net'
import { Subscription } from 'rxjs'
import { AppService, LogService, Logger, ProfilesService } from 'tabby-core'
import { TabRegistry } from './tab-registry'
import { getSocketPath } from './socket-path'
import {
  pipeLines, writeJson,
  FollowerTabInfo, LeaderRpcRequest, LeaderRpcResponse,
} from './wire'
import {
  listTabProcessesFull, getTabName, isWslTab,
  sendToTabLocal, renameTabLocal,
} from './tab-actions'

const INITIAL_RETRY_MS = 500
const MAX_RETRY_MS = 30000

export interface FollowerStartOptions {
  registry: TabRegistry
  logSvc: LogService
  app: AppService
  profiles: ProfilesService
  zone: NgZone
  windowId: number
}

@Injectable({ providedIn: 'root' })
export class FollowerClient {
  private opts!: FollowerStartOptions
  private log!: Logger
  private sock?: Socket
  private starting?: Promise<void>
  private stopped = false
  private retryDelay = INITIAL_RETRY_MS
  private retryTimer?: ReturnType<typeof setTimeout>
  // Last-known tab set: id → info. We push diffs to the leader on registry events.
  private knownTabs = new Map<string, FollowerTabInfo>()
  private regSub?: Subscription

  async start (opts: FollowerStartOptions): Promise<void> {
    if (this.starting) return this.starting
    if (this.stopped) return
    this.opts = opts
    this.log = opts.logSvc.create('agent-chat:follower')
    this.starting = this.connectLoop()
    try { await this.starting } finally { this.starting = undefined }
  }

  private async connectLoop () {
    while (!this.stopped) {
      try {
        await this.connectOnce()
        // connectOnce resolves when socket closes; loop back and reconnect
      } catch (e: any) {
        this.log.warn(`connect failed: ${e?.message ?? e}; retrying in ${this.retryDelay}ms`)
      }
      if (this.stopped) return
      await new Promise<void>(resolve => {
        this.retryTimer = setTimeout(resolve, this.retryDelay)
        this.retryTimer.unref?.()
      })
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS)
    }
  }

  private connectOnce (): Promise<void> {
    return new Promise((resolve, reject) => {
      const sockPath = getSocketPath()
      const sock = createConnection(sockPath)
      let connected = false
      sock.once('error', e => {
        if (!connected) reject(e)
        // post-connect errors handled by 'close'
      })
      sock.once('connect', () => {
        connected = true
        this.retryDelay = INITIAL_RETRY_MS
        this.sock = sock
        this.log.info(`connected to leader at ${sockPath} (window=${this.opts.windowId})`)
        this.subscribeRegistry()
        this.sendHello()
        pipeLines(sock, line => this.onLine(line))
      })
      sock.on('close', () => {
        if (this.sock === sock) this.sock = undefined
        this.unsubscribeRegistry()
        if (connected) {
          this.log.info('disconnected from leader')
          resolve()
        }
      })
    })
  }

  async stop () {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.unsubscribeRegistry()
    if (this.sock) {
      try { this.sock.destroy() } catch { /* gone */ }
      this.sock = undefined
    }
  }

  // ---------------------------------------------------------------- registry tracking

  private subscribeRegistry () {
    this.knownTabs = new Map(this.opts.registry.list().map(e => [e.id, this.makeInfo(e.id, e.tab)]))
    // We don't have direct tab-added/removed events on the registry, but
    // tabsChanged$ fires on every add/remove/rename — diff against last known
    // and emit deltas.
    this.regSub = this.opts.app.tabsChanged$.subscribe(() => this.diffAndPush())
  }

  private unsubscribeRegistry () {
    this.regSub?.unsubscribe()
    this.regSub = undefined
  }

  private makeInfo (id: string, tab: any): FollowerTabInfo {
    return { id, name: getTabName(tab), isWsl: isWslTab(tab) }
  }

  private sendHello () {
    if (!this.sock) return
    const tabs: FollowerTabInfo[] = [...this.knownTabs.values()]
    writeJson(this.sock, { _event: 'hello', windowId: this.opts.windowId, tabs })
  }

  private diffAndPush () {
    if (!this.sock) return
    const current = new Map(this.opts.registry.list().map(e => [e.id, this.makeInfo(e.id, e.tab)]))
    // Removed
    for (const id of this.knownTabs.keys()) {
      if (!current.has(id)) {
        writeJson(this.sock, { _event: 'tab_removed', tabId: id })
      }
    }
    // Added or renamed
    for (const [id, info] of current.entries()) {
      const prev = this.knownTabs.get(id)
      if (!prev) {
        writeJson(this.sock, { _event: 'tab_added', tab: info })
      } else if (prev.name !== info.name) {
        writeJson(this.sock, { _event: 'tab_renamed', tabId: id, name: info.name })
      }
    }
    this.knownTabs = current
  }

  // ---------------------------------------------------------------- RPC handling

  private onLine (line: string) {
    let msg: any
    try { msg = JSON.parse(line) }
    catch { this.log.warn(`bad json from leader: ${line.slice(0, 80)}`); return }
    if (!msg || typeof msg._rpc !== 'string' || typeof msg._rpcId !== 'string') {
      this.log.warn(`unexpected message from leader: ${line.slice(0, 80)}`)
      return
    }
    this.handleRpc(msg as LeaderRpcRequest)
  }

  private async handleRpc (req: LeaderRpcRequest) {
    const respond = (resp: Omit<LeaderRpcResponse, '_rpcId'>) => {
      if (!this.sock) return
      writeJson(this.sock, { _rpcId: req._rpcId, ...resp })
    }
    try {
      switch (req._rpc) {
        case 'list_tab_processes': {
          const entry = this.opts.registry.get(req.tabId)
          if (!entry) return respond({ _error: { code: 'unknown_tab', message: `no tab with id ${req.tabId}` } })
          const r = await listTabProcessesFull(entry.tab, req.tabId)
          return respond({ _result: { processes: r.processes, ...(r.error ? { error: r.error } : {}) } })
        }
        case 'send_to_tab': {
          const res = await sendToTabLocal(this.opts.registry, this.opts.app, this.opts.zone, req.args ?? {}, this.log)
          return respond({ _result: res })
        }
        case 'rename_tab': {
          const known = new Set<string>(Array.isArray(req.knownNames) ? req.knownNames : [])
          const res = renameTabLocal(this.opts.registry, this.opts.app, req.args ?? {}, known, this.log)
          // Push the rename to the leader's cache too — leader updates on
          // success via the rpc response, but tab_renamed makes it idempotent.
          if (res.ok && this.sock) {
            writeJson(this.sock, { _event: 'tab_renamed', tabId: req.tabId, name: res.name })
          }
          return respond({ _result: res })
        }
        default:
          return respond({ _error: { code: 'unknown_rpc', message: `unknown rpc: ${req._rpc}` } })
      }
    } catch (e: any) {
      return respond({ _error: { code: 'internal', message: e?.message ?? String(e) } })
    }
  }
}
