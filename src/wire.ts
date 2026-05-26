import { Socket } from 'net'

// Newline-delimited JSON framing for the MCP transport.

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
  // JSON.stringify errors here are programmer errors (cycle, BigInt) — let
  // them propagate to the dispatcher's try/catch. Only catch the socket write,
  // which can legitimately fail mid-flight (EPIPE etc.).
  const line = JSON.stringify(obj) + '\n'
  try { return sock.write(line) } catch { return false }
}
