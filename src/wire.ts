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
  try {
    return sock.write(JSON.stringify(obj) + '\n')
  } catch {
    return false
  }
}
