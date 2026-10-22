/** Native account page bridge, installed only into the owned application main frame. */
import { contextBridge, ipcRenderer } from 'electron'
import { createHalluCodexAccountUi, halluCodexAccountCopy, type HalluCodexAccountPage, type HalluCodexAccountUiOperations } from './hallucodex/account-ui.ts'
import type { HalluCodexDesktopSnapshot } from './hallucodex/runtime.ts'

/** Account summary the page's sidebar entry may read; it carries no credentials, group or wallet data. */
export interface HalluCodexSidebarAccount {
  readonly status: 'signed-out' | 'signing-in' | 'signed-in'
  /** Display name, or the account ID when the name is empty; present only while signed in. */
  readonly name?: string
}

/**
 * Project one desktop snapshot to the sidebar entry's summary.
 * @param snapshot - Snapshot from the main process, or null before the runtime exists.
 * @returns The renderer-safe summary.
 */
export function sidebarAccount(snapshot: HalluCodexDesktopSnapshot | null): HalluCodexSidebarAccount {
  const account = snapshot?.account
  if (account === undefined) return { status: 'signed-out' }
  if (account.status !== 'signed-in') return { status: account.status }
  return { status: 'signed-in', name: account.profile.displayName || account.profile.id }
}

/** Shell requests to show the account page, held for the client page until it listens. */
export interface AccountOpenRequests {
  /** Ask every listener to show the page; with none yet, keep one request for the first listener. */
  request(): void
  /**
   * Receive later requests, and a kept one on the next microtask.
   * @param listener - Shows the account page.
   * @returns Stop receiving requests.
   */
  listen(listener: () => void): () => void
}

/**
 * Create the request queue between the main process and the client page.
 * @returns A queue that keeps at most one request made before any listener.
 */
export function createAccountOpenRequests(): AccountOpenRequests {
  const listeners = new Set<() => void>()
  let kept = false
  return {
    request() {
      if (listeners.size === 0) { kept = true; return }
      for (const listener of listeners) listener()
    },
    listen(listener) {
      listeners.add(listener)
      if (kept) {
        kept = false
        queueMicrotask(() => { if (listeners.has(listener)) listener() })
      }
      return () => { listeners.delete(listener) }
    },
  }
}

/** Install the account page bridge without exposing raw IPC or secret-bearing operations. */
export function installHalluCodexAccountUi(): void {
  const operations: HalluCodexAccountUiOperations = {
    state: () => ipcRenderer.invoke('hallucodex:state') as Promise<HalluCodexDesktopSnapshot | null>,
    start: () => ipcRenderer.invoke('hallucodex:start') as Promise<HalluCodexDesktopSnapshot>,
    cancel: () => ipcRenderer.invoke('hallucodex:cancel') as Promise<HalluCodexDesktopSnapshot>,
    signOut: () => ipcRenderer.invoke('hallucodex:sign-out') as Promise<{ remoteRevoked: boolean }>,
    openPage: page => ipcRenderer.invoke('hallucodex:open-page', page) as Promise<void>,
    refresh: () => ipcRenderer.invoke('hallucodex:refresh') as ReturnType<HalluCodexAccountUiOperations['refresh']>,
    refreshCatalog: () => ipcRenderer.invoke('hallucodex:refresh-catalog') as ReturnType<HalluCodexAccountUiOperations['refreshCatalog']>,
    restore: () => ipcRenderer.invoke('hallucodex:restore') as ReturnType<HalluCodexAccountUiOperations['restore']>,
    refreshWallet: () => ipcRenderer.invoke('hallucodex:refresh-wallet') as Promise<void>,
    selectGroup: selection => ipcRenderer.invoke('hallucodex:select-group', selection) as ReturnType<HalluCodexAccountUiOperations['selectGroup']>,
    setServer: origin => ipcRenderer.invoke('hallucodex:set-server', origin) as Promise<HalluCodexDesktopSnapshot>,
    subscribe(listener) {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: HalluCodexDesktopSnapshot): void => { listener(snapshot) }
      ipcRenderer.on('hallucodex:changed', handler)
      return () => { ipcRenderer.off('hallucodex:changed', handler) }
    },
  }
  let ui: HalluCodexAccountPage | undefined
  let chinese: boolean | undefined
  let hosts: { head: HTMLElement; content: HTMLElement } | undefined
  // The page follows the client's <html lang>; a change between Chinese and English re-creates it in place.
  const render = (): void => {
    const current = document.documentElement.lang || navigator.language
    const wantsChinese = current.toLowerCase().startsWith('zh')
    if (ui === undefined || wantsChinese !== chinese) {
      ui?.dispose()
      chinese = wantsChinese
      ui = createHalluCodexAccountUi(document, operations, halluCodexAccountCopy(current))
    }
    if (hosts === undefined) return
    void ui.mount(hosts.head, hosts.content).catch((_mountError: unknown) => { /* A disposed page renders nothing. */ })
  }
  const language = new MutationObserver(() => { render() })
  const opens = createAccountOpenRequests()
  const open = (): void => { opens.request() }
  ipcRenderer.on('hallucodex:open', open)
  contextBridge.exposeInMainWorld('dshHalluCodex', {
    subscribe(listener: (state: HalluCodexSidebarAccount) => void): () => void {
      let active = true
      let changed = false
      const unsubscribe = operations.subscribe((snapshot) => { changed = true; listener(sidebarAccount(snapshot)) })
      void operations.state().then(
        (snapshot) => { if (active && !changed) listener(sidebarAccount(snapshot)) },
        (_stateError: unknown) => { /* The entry stays signed out until the next change. */ },
      )
      return () => { active = false; unsubscribe() }
    },
    onOpen: (listener: () => void): (() => void) => opens.listen(listener),
    mount(head: unknown, content: unknown): () => void {
      if (!(head instanceof HTMLElement) || !(content instanceof HTMLElement) || !head.isConnected || !content.isConnected) {
        throw new TypeError('hallucodex: the account page needs connected head and content hosts')
      }
      const mounted = { head, content }
      hosts = mounted
      language.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
      render()
      return () => {
        if (hosts !== mounted) return
        hosts = undefined
        language.disconnect()
        ui?.unmount()
      }
    },
  })
  window.addEventListener('unload', () => { ipcRenderer.off('hallucodex:open', open); language.disconnect(); ui?.dispose() }, { once: true })
}
