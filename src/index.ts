/* eslint-disable @typescript-eslint/no-extraneous-class */
import { NgModule } from '@angular/core'
import { AppService } from 'tabby-core'

import { TabRegistry } from './tab-registry'
import { McpServer } from './mcp-server'

@NgModule({
  providers: [TabRegistry, McpServer],
})
export default class InputBrokerModule {
  constructor (app: AppService, registry: TabRegistry, server: McpServer) {
    registry.attach(app)
    server.start(registry)
  }
}
