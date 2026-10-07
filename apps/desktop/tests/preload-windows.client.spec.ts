// @vitest-environment jsdom
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { syncWindowsAppearance } from '../src/preload-windows.ts'

const send = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcRenderer: { send } }))
vi.mock('../src/preload-menu.ts', () => ({ installWindowsMenu: () => ({ update: vi.fn(), dispose: vi.fn() }) }))

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  document.documentElement.removeAttribute('data-windows-titlebar')
  document.documentElement.style.removeProperty('--dsh-windows-titlebar-height')
  document.documentElement.lang = 'en'
  document.body.removeAttribute('data-ds-dark-theme')
  vi.restoreAllMocks()
  send.mockClear()
})

it.each(['darwin', 'freebsd'] as const)('does not install caption controls on %s', (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  syncWindowsAppearance()
  expect(document.documentElement.hasAttribute('data-windows-titlebar')).toBe(false)
  expect(send).not.toHaveBeenCalled()
})

it.each(['win32', 'linux'] as const)('synchronizes live language and palette changes on %s and stops observing a closed document', async (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation(() => ({
    backgroundColor: document.body.hasAttribute('data-ds-dark-theme') ? 'oklch(0.2 0 0)' : 'hsl(0 0% 100%)',
    color: 'black',
  }) as CSSStyleDeclaration)
  const context = {
    fillStyle: '', clearRect: vi.fn(), fillRect: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(context.fillStyle === 'black'
      ? [0, 0, 0, 255] : context.fillStyle.startsWith('oklch') ? [27, 27, 28, 255] : [255, 255, 255, 255]) }),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  document.documentElement.lang = 'en'
  syncWindowsAppearance()
  expect(send).not.toHaveBeenCalled()
  expect(document.documentElement.hasAttribute('data-windows-titlebar')).toBe(true)
  window.dispatchEvent(new Event('DOMContentLoaded'))
  expect(document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height')).toBe('40px')
  expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.windowsAppearance, 'en', 'rgba(255, 255, 255, 1)', 'rgba(0, 0, 0, 1)')
  document.documentElement.lang = 'zh-CN'
  document.body.setAttribute('data-ds-dark-theme', '')
  await vi.waitFor(() => { expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.windowsAppearance, 'zh-CN', 'rgba(27, 27, 28, 1)', 'rgba(0, 0, 0, 1)') })
  window.dispatchEvent(new Event('pagehide'))
  send.mockClear()
  document.documentElement.lang = 'en'
  await new Promise<void>((resolve) => { queueMicrotask(resolve) })
  expect(send).not.toHaveBeenCalled()
})

it('tints the caption with the backdrop of an open modal dialog and restores it on close', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  const dialog = document.createElement('dialog')
  document.body.append(dialog)
  onTestFinished(() => { dialog.remove() })
  // jsdom implements neither showModal nor the :modal state.
  const modal = { open: false }
  vi.spyOn(dialog, 'matches').mockImplementation(selector => selector === ':modal' && modal.open)
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((_element, pseudo) => (pseudo === '::backdrop'
    ? { backgroundColor: 'rgb(0 0 0 / 30%)' } : { backgroundColor: 'hsl(0 0% 100%)', color: 'black' }) as CSSStyleDeclaration)
  // The canvas composites the backdrop over each caption color.
  const pixels: Record<string, number[]> = {
    'hsl(0 0% 100%)': [255, 255, 255, 255], 'black': [0, 0, 0, 255],
    'hsl(0 0% 100%) + rgb(0 0 0 / 30%)': [179, 179, 179, 255], 'black + rgb(0 0 0 / 30%)': [0, 0, 0, 255],
  }
  let layers: string[] = []
  const context = {
    fillStyle: '', clearRect: vi.fn(() => { layers = [] }), fillRect: vi.fn(() => { layers.push(context.fillStyle) }),
    getImageData: () => ({ data: new Uint8ClampedArray(pixels[layers.join(' + ')]!) }),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
  syncWindowsAppearance()
  expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.windowsAppearance, 'en', 'rgba(255, 255, 255, 1)', 'rgba(0, 0, 0, 1)')
  modal.open = true
  dialog.setAttribute('open', '')
  await vi.waitFor(() => { expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.windowsAppearance, 'en', 'rgba(179, 179, 179, 1)', 'rgba(0, 0, 0, 1)') })
  modal.open = false
  dialog.removeAttribute('open')
  await vi.waitFor(() => { expect(send).toHaveBeenLastCalledWith(DESKTOP_IPC.windowsAppearance, 'en', 'rgba(255, 255, 255, 1)', 'rgba(0, 0, 0, 1)') })
})
