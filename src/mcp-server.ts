import { Injectable } from '@angular/core'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { TabRegistry } from './tab-registry'

interface ChildProcess { pid: number; ppid: number; command: string }

@Injectable({ providedIn: 'root' })
export class McpServer {
  private token = randomUUID()
  private port = 0

  start (registry: TabRegistry) {
    const srv = createServer((req, res) => this.handle(req, res, registry))
    srv.listen(0, '127.0.0.1', () => {
      this.port = (srv.address() as any).port
      console.log(`[tabby-input-broker] http://127.0.0.1:${this.port}/mcp  token=${this.token}`)
    })
  }

  private async handle (req: IncomingMessage, res: ServerResponse, registry: TabRegistry) {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      return this.json(res, 401, { error: 'unauthorized' })
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      return this.json(res, 404, { error: 'not found' })
    }
    const body = await this.readBody(req)
    let msg: any
    try { msg = JSON.parse(body) } catch { return this.json(res, 400, { error: 'bad json' }) }

    const reply = await this.dispatch(msg, registry)
    return this.json(res, 200, reply)
  }

  private async dispatch (msg: any, registry: TabRegistry): Promise<any> {
    const reply = (result: any) => ({ jsonrpc: '2.0', id: msg.id, result })
    const err = (code: number, message: string) =>
      ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'tabby-input-broker', version: '0.1.0' },
        capabilities: { tools: {} },
      })
    }
    if (msg.method === 'tools/list') {
      return reply({ tools: [
        {
          name: 'list_tabs',
          description: 'List Tabby tabs in this window with their running processes.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          name: 'send_to_tab',
          description: 'Inject text into the target tab as if typed/pasted. Use list_tabs to find ids.',
          inputSchema: {
            type: 'object',
            required: ['tab_id', 'text'],
            additionalProperties: false,
            properties: {
              tab_id: { type: 'string' },
              text: { type: 'string' },
              submit: { type: 'boolean', default: true },
              mode: { type: 'string', enum: ['paste', 'keystrokes'], default: 'paste' },
            },
          },
        },
      ] })
    }
    if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params ?? {}
      try {
        if (name === 'list_tabs') return reply(await this.toolListTabs(registry))
        if (name === 'send_to_tab') return reply(await this.toolSend(registry, args ?? {}))
        return err(-32601, `unknown tool: ${name}`)
      } catch (e: any) {
        return reply({ content: [{ type: 'text', text: e?.message ?? String(e) }], isError: true })
      }
    }
    return err(-32601, `unknown method: ${msg.method}`)
  }

  private async toolListTabs (registry: TabRegistry) {
    const tabs = await Promise.all(registry.list().map(async e => {
      const session: any = e.tab.session
      let processes: ChildProcess[] = []
      if (typeof session?.getChildProcesses === 'function') {
        try { processes = await session.getChildProcesses() } catch {}
      }
      return { id: e.id, title: e.tab.title, processes }
    }))
    return { structuredContent: { tabs }, content: [{ type: 'text', text: JSON.stringify({ tabs }) }] }
  }

  private async toolSend (registry: TabRegistry, args: any) {
    const id: string = args.tab_id
    const text: string = args.text
    const submit: boolean = args.submit ?? true
    const mode: 'paste'|'keystrokes' = args.mode ?? 'paste'

    const entry = registry.get(id)
    if (!entry) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `no tab with id ${id}` }) }], isError: true }
    }

    let payload = text
    if (mode === 'paste') payload = `\x1b[200~${text}\x1b[201~`
    if (submit) payload += '\r'
    entry.tab.sendInput(Buffer.from(payload, 'utf8'))

    return { structuredContent: { ok: true }, content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
  }

  private readBody (req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  private json (res: ServerResponse, status: number, body: any) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}
