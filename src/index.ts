/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { AppService, LogService, ProfilesService } from 'tabby-core'

import { TabRegistry } from './tab-registry'
import { McpServer } from './mcp-server'

@NgModule({
  providers: [TabRegistry, McpServer],
})
export default class AgentChatModule {
  constructor (
    app: AppService,
    logSvc: LogService,
    profiles: ProfilesService,
    registry: TabRegistry,
    server: McpServer,
  ) {
    registry.init(app, logSvc)
    server.start({ registry, logSvc, app, profiles }).catch(err => {
      logSvc.create('agent-chat').error('failed to start MCP server', err)
    })
  }
}
