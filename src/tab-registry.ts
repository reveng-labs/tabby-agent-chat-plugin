import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { AppService, BaseTabComponent, LogService, Logger } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

// Duck-type a SplitTabComponent without referencing the class directly.
// We're loaded as an external module, so `instanceof` against tabby-core's
// class can fail when the import alias points at a fresh module instance.
function isSplit (tab: any): boolean {
  return tab && typeof tab.getAllTabs === 'function' && tab.tabAdded$ && tab.tabRemoved$
}

export interface TabEntry {
  id: string
  tab: BaseTerminalTabComponent<any>
}

@Injectable({ providedIn: 'root' })
export class TabRegistry {
  private entries = new Map<string, TabEntry>()
  private byTab = new WeakMap<BaseTerminalTabComponent<any>, string>()
  private perTabSubs = new WeakMap<BaseTabComponent, Subscription>()
  private pendingFirstOutput = new WeakSet<BaseTerminalTabComponent<any>>()
  private appSubs = new Subscription()
  private log!: Logger

  init (app: AppService, logSvc: LogService) {
    this.log = logSvc.create('input-broker:registry')
    for (const t of app.tabs) this.safeWalk(t)
    // Wrap callbacks: an unhandled throw kills the Subject's subscription.
    this.appSubs.add(app.tabOpened$.subscribe(t => this.safeWalk(t)))
    this.appSubs.add(app.tabClosed$.subscribe(t => this.safeForget(t)))
  }

  private safeWalk (tab: BaseTabComponent) {
    try { this.walkTopLevel(tab) }
    catch (e: any) { this.log.error(`walkTopLevel failed for ${tab?.constructor?.name}: ${e?.message}`, e) }
  }
  private safeForget (tab: BaseTabComponent) {
    try { this.forgetTopLevel(tab) }
    catch (e: any) { this.log.error(`forgetTopLevel failed for ${tab?.constructor?.name}: ${e?.message}`, e) }
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
    if (isSplit(tab)) {
      const split: any = tab
      const sub = new Subscription()
      // Walk children now (covers freshly-created splits).
      for (const child of split.getAllTabs()) this.tryRegisterTerminal(child)
      // …and again after ngAfterViewInit: for *recovered* splits the
      // children populate via recoverContainer() without firing tabAdded$,
      // so this is the only way they ever become visible.
      if (split.initialized$) {
        sub.add(split.initialized$.subscribe(() => {
          for (const child of split.getAllTabs()) this.tryRegisterTerminal(child)
        }))
      }
      sub.add(split.tabAdded$.subscribe((child: BaseTabComponent) => this.tryRegisterTerminal(child)))
      sub.add(split.tabRemoved$.subscribe((child: BaseTabComponent) => this.unregisterTerminal(child)))
      this.perTabSubs.set(tab, sub)
    } else {
      this.tryRegisterTerminal(tab)
    }
  }

  private forgetTopLevel (tab: BaseTabComponent) {
    this.perTabSubs.get(tab)?.unsubscribe()
    this.perTabSubs.delete(tab)
    if (isSplit(tab)) {
      for (const child of (tab as any).getAllTabs()) this.unregisterTerminal(child)
    } else {
      this.unregisterTerminal(tab)
    }
  }

  private tryRegisterTerminal (tab: BaseTabComponent) {
    if (!(tab as any).sessionChanged$) return
    const term = tab as BaseTerminalTabComponent<any>

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
    if (!id) {
      // PTY hasn't started yet — getID() becomes valid once PTYProxy is set
      // during session.start(). First output byte = "session is alive" signal.
      // Guard against piling up multiple once-subs if registerIfReady fires
      // repeatedly (rapid sessionChanged$ churn).
      if (session.binaryOutput$ && !this.byTab.get(term) && !this.pendingFirstOutput.has(term)) {
        this.pendingFirstOutput.add(term)
        const onceSub = session.binaryOutput$.subscribe(() => {
          onceSub.unsubscribe()
          this.pendingFirstOutput.delete(term)
          this.registerIfReady(term)
        })
        this.perTabSubs.get(term)?.add(onceSub)
      }
      return
    }
    this.pendingFirstOutput.delete(term)

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
    this.pendingFirstOutput.delete(term)
    const id = this.byTab.get(term)
    if (id) {
      this.entries.delete(id)
      this.byTab.delete(term)
      this.log.info(`unregistered tab ${id}`)
    }
  }
}
