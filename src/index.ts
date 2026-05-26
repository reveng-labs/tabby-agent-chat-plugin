/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule, Inject, NgZone } from '@angular/core'
import * as path from 'path'
import { AppService, BOOTSTRAP_DATA, BootstrapData, LogService, Logger, ProfilesService } from 'tabby-core'

import { TabRegistry, TAB_ID_ENV_KEY } from './tab-registry'
import { McpServer } from './mcp-server'
import { getOrAllocateSocketPath } from './socket-path'

// dist/index.js sits at <install>/dist/index.js; INSTALL.md is one dir up,
// shim.js is built next to us in dist/.
const INSTALL_FILE = path.resolve(__dirname, '..', 'INSTALL.md')
const SHIM_FILE = path.resolve(__dirname, 'shim.js')

const WSLENV_NAMES = new Set([
  'TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS',
  TAB_ID_ENV_KEY,
])

function setWslenv (entries: string[]) {
  const existing = (process.env.WSLENV ?? '').split(':').filter(s => s.length > 0)
  const kept = existing.filter(e => !WSLENV_NAMES.has(e.split('/')[0]))
  process.env.WSLENV = [...kept, ...entries].join(':')
}

function injectEnv (log: Logger) {
  // Allocate (or reuse, when overridden by test env) this window's socket
  // path, then put it into process.env so shells in this window's tabs
  // inherit it. Different windows are separate renderer processes with
  // independent process.env, so each window's tabs only see their own path.
  const sockPath = getOrAllocateSocketPath()
  process.env.TABBY_AGENT_CHAT_SOCKET = sockPath
  process.env.TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS = INSTALL_FILE
  process.env.TABBY_AGENT_CHAT_SHIM = SHIM_FILE
  // SOCKET/SHIM paths are renderer-OS-local — WSL agents can't connect anyway.
  // INSTALL.md path is annotated /p so wsl.exe translates the path; TAB_ID is
  // an opaque string set per-tab on profile.options.env (the registry handles
  // it; WSLENV here just whitelists the name for cross-boundary inheritance).
  setWslenv(['TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS/p', TAB_ID_ENV_KEY])
  log.info(`env injected: SOCKET=${sockPath}, SHIM=${SHIM_FILE}`)
}

@NgModule({
  providers: [TabRegistry, McpServer],
})
export default class AgentChatModule {
  constructor (
    app: AppService,
    logSvc: LogService,
    profiles: ProfilesService,
    zone: NgZone,
    registry: TabRegistry,
    server: McpServer,
    @Inject(BOOTSTRAP_DATA) bootstrap: BootstrapData,
  ) {
    const log = logSvc.create('agent-chat')
    registry.init(app, logSvc)
    injectEnv(log)
    log.info(`window id=${bootstrap.windowID} (main=${bootstrap.isMainWindow}) — starting MCP server`)
    server.start({ registry, logSvc, app, profiles, zone, windowId: bootstrap.windowID }).catch(err =>
      log.error('MCP server failed to start', err))
  }
}
