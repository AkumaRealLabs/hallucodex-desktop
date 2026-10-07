/** Native account UI bridge, installed only into the owned application main frame. */
import { contextBridge, ipcRenderer } from 'electron'
import { createHalluCodexAccountUi, halluCodexAccountCopy, type HalluCodexAccountUiOperations } from './hallucodex/account-ui.ts'
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

/** Install the account dialog without exposing raw IPC or secret-bearing operations. */
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
    selectGroup: group => ipcRenderer.invoke('hallucodex:select-group', group) as ReturnType<HalluCodexAccountUiOperations['selectGroup']>,
    setServer: origin => ipcRenderer.invoke('hallucodex:set-server', origin) as Promise<HalluCodexDesktopSnapshot>,
    subscribe(listener) {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: HalluCodexDesktopSnapshot): void => { listener(snapshot) }
      ipcRenderer.on('hallucodex:changed', handler)
      return () => { ipcRenderer.off('hallucodex:changed', handler) }
    },
  }
  let ui: ReturnType<typeof createHalluCodexAccountUi> | undefined
  let chinese: boolean | undefined
  // The menu passes the desktop language; the sidebar entry opens after boot, when <html lang> is already set.
  const openDialog = (desktopLanguage?: unknown): void => {
    const current = typeof desktopLanguage === 'string' ? desktopLanguage : document.documentElement.lang || navigator.language
    const wantsChinese = current.toLowerCase().startsWith('zh')
    if (ui === undefined || wantsChinese !== chinese) {
      ui?.dispose()
      chinese = wantsChinese
      ui = createHalluCodexAccountUi(document, operations, halluCodexAccountCopy(current))
    }
    void ui.open().catch((_openError: unknown) => { /* A closed/disabled account never opens a dialog. */ })
  }
  const open = (_event: Electron.IpcRendererEvent, desktopLanguage?: unknown): void => { openDialog(desktopLanguage) }
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
    open: () => { openDialog() },
  })
  window.addEventListener('unload', () => { ipcRenderer.off('hallucodex:open', open); ui?.dispose() }, { once: true })
}
