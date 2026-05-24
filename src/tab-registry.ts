import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { AppService, BaseTabComponent, LogService, Logger, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

export interface TabEntry {
  id: string
  tab: BaseTerminalTabComponent<any>
}

@Injectable({ providedIn: 'root' })
export class TabRegistry {
  private entries = new Map<string, TabEntry>()
  private byTab = new WeakMap<BaseTerminalTabComponent<any>, string>()
  private perTabSubs = new WeakMap<BaseTabComponent, Subscription>()
  private appSubs = new Subscription()
  private log!: Logger

  init (app: AppService, logSvc: LogService) {
    this.log = logSvc.create('input-broker:registry')

    for (const t of app.tabs) this.walkTopLevel(t)

    this.appSubs.add(app.tabOpened$.subscribe(t => this.walkTopLevel(t)))
    this.appSubs.add(app.tabClosed$.subscribe(t => this.forgetTopLevel(t)))
  }

  destroy () {
    this.appSubs.unsubscribe()
    this.entries.clear()
  }

  list (): TabEntry[] {
    return [...this.entries.values()]
  }

  get (id: string): TabEntry | undefined {
    return this.entries.get(id)
  }

  private walkTopLevel (tab: BaseTabComponent) {
    // If we've already walked this tab (e.g., reparented), drop the old sub first.
    this.perTabSubs.get(tab)?.unsubscribe()
    if (tab instanceof SplitTabComponent) {
      const sub = new Subscription()
      for (const child of tab.getAllTabs()) this.tryRegisterTerminal(child)
      sub.add(tab.tabAdded$.subscribe(child => this.tryRegisterTerminal(child)))
      sub.add(tab.tabRemoved$.subscribe(child => this.unregisterTerminal(child)))
      this.perTabSubs.set(tab, sub)
    } else {
      this.tryRegisterTerminal(tab)
    }
  }

  private forgetTopLevel (tab: BaseTabComponent) {
    this.perTabSubs.get(tab)?.unsubscribe()
    this.perTabSubs.delete(tab)
    if (tab instanceof SplitTabComponent) {
      for (const child of tab.getAllTabs()) this.unregisterTerminal(child)
    } else {
      this.unregisterTerminal(tab)
    }
  }

  private tryRegisterTerminal (tab: BaseTabComponent) {
    if (!(tab as any).sessionChanged$) return
    const term = tab as BaseTerminalTabComponent<any>

    // If the same pane is reparented across splits we may walk it twice;
    // drop the previous sub before installing a new one to avoid a leak.
    this.perTabSubs.get(term)?.unsubscribe()

    const sub = new Subscription()
    sub.add(term.sessionChanged$.subscribe(() => this.registerIfReady(term)))
    sub.add(term.destroyed$.subscribe(() => this.unregisterTerminal(term)))
    this.perTabSubs.set(term, sub)

    this.registerIfReady(term)
  }

  private registerIfReady (term: BaseTerminalTabComponent<any>) {
    const session: any = term.session
    if (!session || typeof session.getID !== 'function') return
    const id = session.getID()
    if (!id) return

    const prev = this.byTab.get(term)
    if (prev === id) return
    if (prev) this.entries.delete(prev)

    if (this.entries.has(id)) {
      this.log.warn(`duplicate session id ${id}; overwriting`)
    }
    this.entries.set(id, { id, tab: term })
    this.byTab.set(term, id)
    this.log.info(`registered tab ${id} (${term.title})`)
  }

  private unregisterTerminal (tab: BaseTabComponent) {
    this.perTabSubs.get(tab)?.unsubscribe()
    this.perTabSubs.delete(tab)
    const term = tab as BaseTerminalTabComponent<any>
    const id = this.byTab.get(term)
    if (id) {
      this.entries.delete(id)
      this.byTab.delete(term)
      this.log.info(`unregistered tab ${id}`)
    }
  }
}
