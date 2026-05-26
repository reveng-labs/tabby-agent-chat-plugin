#!/usr/bin/env node
// Stdio MCP shim. The agent (Claude Code, Codex, …) spawns this as a child
// and talks JSON-RPC over its stdin/stdout. The shim is a pure byte proxy
// to the Tabby plugin's UDS — no parsing, no framing logic. Newlines pass
// through verbatim, which preserves MCP's line-delimited framing on both
// sides of the pipe.
//
// The socket path is per-window and is communicated via the
// $TABBY_AGENT_CHAT_SOCKET env var, which the Tabby plugin sets on the
// renderer and which spawned shells (and their children, including this
// shim) inherit. Running the shim from a shell that wasn't started by
// Tabby will not find the env var; it exits with a clear error.
//
// On connect failure or socket drop, the shim exits non-zero. The agent
// will respawn the shim next time it needs the MCP, so transient failures
// (Tabby restarting) heal automatically.

import { createConnection } from 'net'
import { readSocketPathFromEnv } from './socket-path'

function fail (msg: string, code = 1): never {
  // stderr only — anything on stdout corrupts MCP framing.
  process.stderr.write(`tabby-agent-chat shim: ${msg}\n`)
  process.exit(code)
}

const sockPath = readSocketPathFromEnv()
if (!sockPath) {
  fail('TABBY_AGENT_CHAT_SOCKET not set — run this from a shell inside a Tabby tab')
}
const sock = createConnection(sockPath)

sock.on('error', e => fail(`cannot connect to ${sockPath}: ${e.message}`))
sock.on('close', () => process.exit(0))
sock.on('end', () => process.exit(0))

process.stdin.on('data', chunk => {
  if (!sock.write(chunk)) {
    // backpressure — pause until the socket drains
    process.stdin.pause()
    sock.once('drain', () => process.stdin.resume())
  }
})
process.stdin.on('end', () => { try { sock.end() } catch { /* ignore */ } })
process.stdin.on('error', e => fail(`stdin error: ${e.message}`))

sock.on('data', chunk => {
  if (!process.stdout.write(chunk)) {
    sock.pause()
    process.stdout.once('drain', () => sock.resume())
  }
})
