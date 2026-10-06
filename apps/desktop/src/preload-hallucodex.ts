/** Native account UI bridge, installed only into the owned application main frame. */
import { ipcRenderer } from 'electron'
import { createHalluCodexAccountUi, halluCodexAccountCopy } from './hallucodex/account-ui.ts'
import type { HalluCodexDesktopSnapshot } from './hallucodex/runtime.ts'

/** Install the account dialog without exposing raw IPC or secret-bearing operations. */
export function installHalluCodexAccountUi(): void {
  const install = (): void => {
    const ui = createHalluCodexAccountUi(document, {
      state: () => ipcRenderer.invoke('hallucodex:state') as Promise<HalluCodexDesktopSnapshot | null>,
      start: () => ipcRenderer.invoke('hallucodex:start') as Promise<HalluCodexDesktopSnapshot>,
      cancel: () => ipcRenderer.invoke('hallucodex:cancel') as Promise<HalluCodexDesktopSnapshot>,
      signOut: () => ipcRenderer.invoke('hallucodex:sign-out') as Promise<{ remoteRevoked: boolean }>,
      openPage: page => ipcRenderer.invoke('hallucodex:open-page', page) as Promise<void>,
      refresh: () => ipcRenderer.invoke('hallucodex:refresh') as Promise<void>,
      subscribe(listener) {
        const handler = (_event: Electron.IpcRendererEvent, snapshot: HalluCodexDesktopSnapshot): void => { listener(snapshot) }
        ipcRenderer.on('hallucodex:changed', handler)
        return () => { ipcRenderer.off('hallucodex:changed', handler) }
      },
    }, halluCodexAccountCopy(document.documentElement.lang || navigator.language))
    const open = (): void => { void ui.open().catch((_openError: unknown) => { /* A closed/disabled account never opens a dialog. */ }) }
    ipcRenderer.on('hallucodex:open', open)
    window.addEventListener('unload', () => { ipcRenderer.off('hallucodex:open', open); ui.dispose() }, { once: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true })
  else install()
}
