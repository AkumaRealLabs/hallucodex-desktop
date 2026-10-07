import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'
/** Synchronizes the Windows and Linux caption menus and colors with the application document. */
import { ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'
import { installWindowsMenu } from './preload-menu.ts'

/** Install the Windows and Linux titlebar marker and observe application language and palette changes. */
export function syncWindowsAppearance(): void {
  // Both platforms replace the native frame with the in-page caption; macOS keeps its inset traffic lights.
  if (process.platform !== 'win32' && process.platform !== 'linux') return
  const mark = (): void => {
    const root = document.documentElement
    root.dataset.windowsTitlebar = ''
    root.style.setProperty('--dsh-windows-titlebar-height', `${WINDOWS_TITLEBAR_HEIGHT}px`)
  }
  // The root can be absent before the HTML parser creates it.
  if ((document.documentElement as HTMLElement | null) !== null) mark()
  const install = (): void => {
    mark()
    const root = document.documentElement
    const menu = installWindowsMenu()
    const probe = document.createElement('span')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;background-color:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-primary)'
    document.body.append(probe)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) throw new Error('Desktop caption requires a 2D canvas context')
    const nativeColor = (color: string, backdrop?: string): string => {
      context.clearRect(0, 0, 1, 1)
      for (const layer of backdrop === undefined ? [color] : [color, backdrop]) {
        context.fillStyle = layer
        context.fillRect(0, 0, 1, 1)
      }
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
      return `rgba(${red}, ${green}, ${blue}, ${Number(alpha) / 255})`
    }
    let previous = ''
    const send = (): void => {
      const style = getComputedStyle(probe)
      // A modal dialog's backdrop dims the page but not the native caption buttons drawn above it, so
      // the caption takes the backdrop's tint while the dialog is open.
      const modal = [...document.querySelectorAll('dialog[open]')].find(dialog => dialog.matches(':modal'))
      const backdrop = modal === undefined ? undefined : getComputedStyle(modal, '::backdrop').backgroundColor
      const color = nativeColor(style.backgroundColor, backdrop)
      const symbolColor = nativeColor(style.color, backdrop)
      const values = [root.lang, color, symbolColor]
      const current = JSON.stringify(values)
      if (current === previous) return
      previous = current
      menu.update()
      ipcRenderer.send(DESKTOP_IPC.windowsAppearance, ...values)
    }
    const observer = new MutationObserver(send)
    observer.observe(root, { attributes: true, attributeFilter: ['lang'] })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    document.head.addEventListener('load', send, true)
    const dialogs = new MutationObserver(send)
    dialogs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] })
    window.addEventListener('pagehide', () => {
      observer.disconnect()
      dialogs.disconnect()
      menu.dispose()
      probe.remove()
      document.head.removeEventListener('load', send, true)
    }, { once: true })
    send()
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', install, { once: true })
  else install()
}
