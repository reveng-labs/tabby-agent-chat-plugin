import { Injectable } from '@angular/core'
import { Subscription } from 'rxjs'
import { randomUUID } from 'crypto'
import { AppService, BaseTabComponent, LogService, Logger } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

export const TAB_ID_ENV_KEY = 'TABBY_AGENT_CHAT_TAB_ID'

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
  private appSubs = new Subscription()
  private log!: Logger

  init (app: AppService, logSvc: LogService) {
    this.log = logSvc.create('agent-chat:registry')
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

    // Idempotent: don't regenerate UUID or re-inject env if we've seen this
    // component before (split-tab walk can revisit children).
    if (this.byTab.has(term)) return

    // tabOpened$ fires inside addTabRaw, BEFORE Angular's resize$ → onFrontendReady →
    // initializeSession → session.start({...this.profile.options, ...}) chain.
    // Each tab's profile is a deepClone (tabby-local/src/profiles.ts:51), so
    // mutating profile.options.env here only affects this tab. Race-free even
    // for burst opens. Captured into spawn env by the spread inside session.start.
    const id = randomUUID()
    const profile: any = term.profile
    // Tabby exposes `profile.options` and `profile.options.env` as getters
    // that proxy into a FullyDefined builder — we can mutate the *returned*
    // object but can't reassign the properties themselves. `env` defaults to
    // an empty object so we can rely on it being there for local profiles.
    const env = profile?.options?.env
    if (env && typeof env === 'object') {
      env[TAB_ID_ENV_KEY] = id
    } else {
      this.log.warn(`tab ${term.constructor?.name} has no profile.options.env; tab id not injected for ${id}`)
    }

    this.entries.set(id, { id, tab: term })
    this.byTab.set(term, id)
    this.log.info(`registered tab ${id} (${term.title || '<no title>'})`)

    // Auto-cleanup on tab destruction.
    const sub = new Subscription()
    sub.add(term.destroyed$.subscribe(() => this.unregisterTerminal(term)))
    this.perTabSubs.set(term, sub)
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
