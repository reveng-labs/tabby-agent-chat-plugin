import { tmpdir, userInfo } from 'os'
import { randomBytes } from 'crypto'
import * as path from 'path'

// One UDS per Tabby window. The plugin allocates a random path on first call
// and caches it; the path is exported via $TABBY_AGENT_CHAT_SOCKET so tabs in
// the same window inherit it and the shim can find its owning window's
// socket. Different windows are different renderer processes with independent
// module state, so each gets its own unique path — no cross-window traffic
// is possible.

let cached: string | undefined

// For the plugin: returns the env-injected path if present (test override),
// otherwise generates a unique path on first call and caches it. The plugin
// is responsible for storing the result back into process.env so spawned
// shells inherit it.
export function getOrAllocateSocketPath (): string {
  const override = process.env.TABBY_AGENT_CHAT_SOCKET
  if (override && override.length > 0) return override
  if (cached) return cached
  cached = generatePath()
  return cached
}

// For the shim: read the env-injected path or null if absent. The shim must
// not allocate — it has to talk to whichever socket its owning Tabby window
// is listening on, which is communicated via env.
export function readSocketPathFromEnv (): string | null {
  const v = process.env.TABBY_AGENT_CHAT_SOCKET
  return (v && v.length > 0) ? v : null
}

function generatePath (): string {
  const token = randomBytes(6).toString('hex')
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\tabby-agent-chat-${userInfo().username}-${token}`
  }
  // XDG_RUNTIME_DIR is per-user tmpfs and gets cleared at logout, so stale
  // sockets after a crash heal themselves. /tmp fallback is less tidy but
  // sockets are zero-byte files so accumulation is harmless.
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg && xdg.length > 0) return path.join(xdg, `tabby-agent-chat-${token}.sock`)
  const uid = (process.getuid?.() ?? userInfo().uid ?? 0)
  return path.join(tmpdir(), `tabby-agent-chat-${uid}-${token}.sock`)
}
