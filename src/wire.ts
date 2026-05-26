import { Socket } from 'net'

// Newline-delimited JSON framing. Used both for MCP traffic (shim ↔ leader)
// and the internal leader↔follower protocol — distinguished by message shape
// not by transport.

export function pipeLines (sock: Socket, onLine: (line: string) => void): void {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', chunk => {
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.length > 0) {
        try { onLine(line) }
        catch { /* handler decides whether to log; we won't tear down the connection */ }
      }
    }
  })
}

export function writeJson (sock: Socket, obj: any): boolean {
  try {
    return sock.write(JSON.stringify(obj) + '\n')
  } catch {
    return false
  }
}

// Internal follower↔leader protocol. Distinct from MCP JSON-RPC by always
// carrying an `_event` or `_rpc` discriminator.

export interface FollowerTabInfo {
  id: string
  name: string | null
  isWsl: boolean
}

export interface FollowerHello {
  _event: 'hello'
  windowId: number
  tabs: FollowerTabInfo[]
}

export interface FollowerTabAdded {
  _event: 'tab_added'
  tab: FollowerTabInfo
}

export interface FollowerTabRemoved {
  _event: 'tab_removed'
  tabId: string
}

export interface FollowerTabRenamed {
  _event: 'tab_renamed'
  tabId: string
  name: string | null
}

export type FollowerEvent =
  | FollowerHello
  | FollowerTabAdded
  | FollowerTabRemoved
  | FollowerTabRenamed

export interface LeaderRpcRequest {
  _rpc: 'send_to_tab' | 'rename_tab' | 'list_tab_processes' | 'close_tab'
  _rpcId: string
  tabId: string
  // call-specific args alongside
  [k: string]: any
}

export interface LeaderRpcResponse {
  _rpcId: string
  _result?: any
  _error?: { code: string, message: string }
}

// Discriminators used by the leader to classify incoming messages.
export function isFollowerEvent (m: any): m is FollowerEvent {
  return m && typeof m === 'object' && typeof m._event === 'string'
}
export function isLeaderRpcResponse (m: any): m is LeaderRpcResponse {
  return m && typeof m === 'object' && typeof m._rpcId === 'string'
    && (m._result !== undefined || m._error !== undefined)
}
