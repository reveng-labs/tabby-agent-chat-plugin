import { tmpdir, userInfo } from 'os'
import * as path from 'path'

// Single conventional socket path. Both the Tabby plugin (server) and the
// stdio shim (client) compute it the same way. Override with
// $TABBY_AGENT_CHAT_SOCKET — used by integration tests to isolate from a
// real running Tabby.
export function getSocketPath (): string {
  const override = process.env.TABBY_AGENT_CHAT_SOCKET
  if (override && override.length > 0) return override
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\tabby-agent-chat-${userInfo().username}`
  }
  // XDG_RUNTIME_DIR is per-user tmpfs on Linux and the right home for runtime
  // sockets. macOS and systems without it fall back to /tmp with a uid
  // suffix so multi-user boxes don't collide.
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg && xdg.length > 0) return path.join(xdg, 'tabby-agent-chat.sock')
  const uid = (process.getuid?.() ?? userInfo().uid ?? 0)
  return path.join(tmpdir(), `tabby-agent-chat-${uid}.sock`)
}
