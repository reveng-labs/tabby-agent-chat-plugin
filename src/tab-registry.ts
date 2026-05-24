import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

export interface TabEntry {
  id: string
  tab: BaseTerminalTabComponent<any>
}

@Injectable({ providedIn: 'root' })
export class TabRegistry {
  private entries = new Map<string, TabEntry>()

  attach (app: AppService) {
    for (const t of app.tabs) this.tryRegister(t)
    app.tabOpened$.subscribe(t => this.tryRegister(t))
    app.tabClosed$.subscribe(t => this.unregister(t))
  }

  list (): TabEntry[] {
    return [...this.entries.values()]
  }

  get (id: string): TabEntry | undefined {
    return this.entries.get(id)
  }

  private tryRegister (tab: BaseTabComponent) {
    const term = tab as BaseTerminalTabComponent<any>
    const session = term.session
    if (!session || typeof (session as any).getID !== 'function') return
    const id = (session as any).getID()
    if (!id) return
    this.entries.set(id, { id, tab: term })
    tab.destroyed$.subscribe(() => this.entries.delete(id))
  }

  private unregister (tab: BaseTabComponent) {
    for (const [id, e] of this.entries) {
      if (e.tab === tab) this.entries.delete(id)
    }
  }
}
