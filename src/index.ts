/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule, Inject, NgZone } from '@angular/core'
import * as path from 'path'
import { AppService, BOOTSTRAP_DATA, BootstrapData, LogService, Logger, ProfilesService } from 'tabby-core'

import { TabRegistry, TAB_ID_ENV_KEY } from './tab-registry'
import { LeaderServer } from './mcp-server'
import { FollowerClient } from './mcp-follower'
import { getSocketPath } from './socket-path'

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
  process.env.TABBY_AGENT_CHAT_SOCKET = getSocketPath()
  process.env.TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS = INSTALL_FILE
  process.env.TABBY_AGENT_CHAT_SHIM = SHIM_FILE
  // SOCKET/SHIM paths are renderer-OS-local — WSL agents can't connect anyway.
  // INSTALL.md path is annotated /p so wsl.exe translates the path; TAB_ID is
  // an opaque string set per-tab on profile.options.env (the registry handles
  // it; WSLENV here just whitelists the name for cross-boundary inheritance).
  setWslenv(['TABBY_AGENT_CHAT_INSTALL_INSTRUCTIONS/p', TAB_ID_ENV_KEY])
  log.info(`env injected: SOCKET=${process.env.TABBY_AGENT_CHAT_SOCKET}, SHIM=${SHIM_FILE}`)
}

@NgModule({
  providers: [TabRegistry, LeaderServer, FollowerClient],
})
export default class AgentChatModule {
  constructor (
    app: AppService,
    logSvc: LogService,
    profiles: ProfilesService,
    zone: NgZone,
    registry: TabRegistry,
    leader: LeaderServer,
    follower: FollowerClient,
    @Inject(BOOTSTRAP_DATA) bootstrap: BootstrapData,
  ) {
    const log = logSvc.create('agent-chat')
    registry.init(app, logSvc)
    injectEnv(log)

    if (bootstrap.isMainWindow) {
      log.info(`main window (id=${bootstrap.windowID}) — starting leader`)
      leader.start({ registry, logSvc, app, profiles, zone }).catch(err =>
        log.error('leader failed to start', err))
    } else {
      log.info(`secondary window (id=${bootstrap.windowID}) — starting follower`)
      follower.start({ registry, logSvc, app, profiles, zone, windowId: bootstrap.windowID }).catch(err =>
        log.error('follower failed to start', err))
    }
  }
}
