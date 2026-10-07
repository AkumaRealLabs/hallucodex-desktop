import { EventEmitter } from 'node:events'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents, WebContentsViewConstructorOptions } from 'electron'
import { DesktopUpdateOverlays, shadeCaptionColor } from '../src/update-overlay.ts'

const native = vi.hoisted(() => ({
  create: vi.fn<(options: BrowserWindowConstructorOptions) => object>(),
  view: vi.fn<(options: WebContentsViewConstructorOptions) => object>(),
}))
vi.mock('electron', () => ({
  BrowserWindow: function (options: BrowserWindowConstructorOptions) { return native.create(options) },
  WebContentsView: function (options: WebContentsViewConstructorOptions) { return native.view(options) },
}))

afterEach(() => { vi.restoreAllMocks() })

function visibilityFixture(visible = true) {
  // Windows and macOS use a child window; Linux embeds a view instead.
  if (process.platform === 'linux') vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const visibility = { visible }
  const parent: ParentFixture & Pick<BrowserWindow, 'isVisible'> = Object.assign(new EventEmitter(), {
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    webContents: Object.assign(new EventEmitter(), { insertCSS: vi.fn(async () => 'blur'), removeInsertedCSS: vi.fn(async () => {}) }),
    isDestroyed: (): boolean => false,
    isVisible: () => visibility.visible,
  })
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    webContents: { setWindowOpenHandler: vi.fn() }, show: vi.fn(), focus: vi.fn(),
    setMenu: vi.fn(), setBounds: vi.fn(), isDestroyed: () => window.destroyed,
  })
  native.create.mockReturnValue(window)
  new DesktopUpdateOverlays().create(parent as BrowserWindow, 'owned', 'Update available', false)
  return { parent, window, visibility }
}

it('restores a ready overlay each time its parent is shown and releases visibility ownership on close', async () => {
  const { parent, window, visibility } = visibilityFixture()
  window.emit('ready-to-show')
  expect(window.show).toHaveBeenCalledOnce()
  for (let index = 0; index < 2; index++) {
    visibility.visible = false
    parent.emit('hide')
    visibility.visible = true
    parent.emit('show')
    await Promise.resolve()
  }
  expect(window.show).toHaveBeenCalledTimes(3)
  await Promise.resolve()
  expect(parent.webContents.removeInsertedCSS).not.toHaveBeenCalled()
  window.destroyed = true
  window.emit('closed')
  expect(parent.listenerCount('show')).toBe(0)
  expect(parent.webContents.insertCSS).not.toHaveBeenCalled()
  expect(parent.webContents.removeInsertedCSS).not.toHaveBeenCalled()
  parent.emit('show')
  expect(window.show).toHaveBeenCalledTimes(3)
})

it('waits for both a visible parent and a ready document, in either order', async () => {
  for (const readyFirst of [true, false]) {
    const { parent, window, visibility } = visibilityFixture(false)
    if (readyFirst) window.emit('ready-to-show')
    else { visibility.visible = true; parent.emit('show') }
    expect(window.show).not.toHaveBeenCalled()
    if (readyFirst) { visibility.visible = true; parent.emit('show') }
    else window.emit('ready-to-show')
    await Promise.resolve()
    expect(window.show).toHaveBeenCalledOnce()
    window.destroyed = true
    window.emit('closed')
  }
})

it('does not show or change parent styles when closed before its document is ready', async () => {
  const { parent, window, visibility } = visibilityFixture(false)
  window.destroyed = true
  window.emit('closed')
  window.emit('ready-to-show')
  visibility.visible = true
  parent.emit('show')
  await Promise.resolve()
  expect(window.show).not.toHaveBeenCalled()
  expect(parent.listenerCount('show')).toBe(0)
  expect(parent.webContents.insertCSS).not.toHaveBeenCalled()
  expect(parent.webContents.removeInsertedCSS).not.toHaveBeenCalled()
})

it('releases a macOS overlay after its parent has already been destroyed', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  const { parent, window } = visibilityFixture()
  await Promise.resolve()
  vi.spyOn(parent, 'isDestroyed').mockReturnValue(true)
  Object.defineProperty(parent, 'webContents', { get() { throw new Error('Object has been destroyed') } })
  window.destroyed = true
  expect(() => window.emit('closed')).not.toThrow()
  for (const event of ['focus', 'move', 'resize', 'show']) expect(parent.listenerCount(event)).toBe(0)
})

type ParentFixture = EventEmitter & Pick<BrowserWindow, 'getContentBounds' | 'isDestroyed'> & {
  webContents: EventEmitter & Pick<WebContents, 'insertCSS' | 'removeInsertedCSS'>
}

it('keeps the macOS update overlay stationary and blocks parent keyboard input until close', () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  const parent: ParentFixture = Object.assign(new EventEmitter(), {
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    webContents: Object.assign(new EventEmitter(), { insertCSS: vi.fn(async () => 'blur'), removeInsertedCSS: vi.fn(async () => {}) }),
    isDestroyed: () => false,
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: { setWindowOpenHandler: vi.fn() }, show: vi.fn(), focus: vi.fn(),
    setMenu: vi.fn(), setBounds: vi.fn(), isDestroyed: () => false,
  })
  native.create.mockReturnValue(window)
  try {
    new DesktopUpdateOverlays().create(parent as BrowserWindow, 'owned', 'Update available', false)
    expect(native.create).toHaveBeenLastCalledWith(expect.objectContaining({ modal: false, transparent: true, frame: false }))
    const event = { preventDefault: vi.fn() }
    parent.webContents.emit('before-input-event', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    window.emit('closed')
    expect(parent.listenerCount('focus')).toBe(0)
    expect(parent.webContents.listenerCount('before-input-event')).toBe(0)
  } finally { platform.mockRestore() }
})

it('blocks each parent until its last owned overlay closes and invalidates each transition', () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  onTestFinished(() => { platform.mockRestore() })
  const parent = (): ParentFixture => Object.assign(new EventEmitter(), {
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    webContents: Object.assign(new EventEmitter(), { insertCSS: vi.fn(async () => 'blur'), removeInsertedCSS: vi.fn(async () => {}) }),
    isDestroyed: () => false,
  })
  const firstParent = parent() as BrowserWindow
  const secondParent = parent() as BrowserWindow
  const overlays = new DesktopUpdateOverlays()
  const isolated = new DesktopUpdateOverlays()
  const created: EventEmitter[] = []
  native.create.mockImplementation(() => {
    const window = Object.assign(new EventEmitter(), {
      webContents: { setWindowOpenHandler: vi.fn() }, show: vi.fn(), focus: vi.fn(),
      setMenu: vi.fn(), setBounds: vi.fn(), isDestroyed: () => false,
    })
    onTestFinished(() => { window.emit('closed') })
    created.push(window)
    return window
  })
  expect(overlays.input(firstParent)).toEqual({ revision: 0, blocked: false })
  const create = (owner: BrowserWindow, title: string): EventEmitter => {
    overlays.create(owner, 'owned', title, false)
    return created.at(-1)!
  }
  const first = create(firstParent, 'Update available')
  const second = create(firstParent, 'Confirm installation')
  const other = create(secondParent, 'Update available')
  expect(overlays.input(firstParent)).toMatchObject({ revision: 2, blocked: true })
  expect(overlays.input(secondParent)).toMatchObject({ revision: 1, blocked: true })
  expect(isolated.input(firstParent)).toEqual({ revision: 0, blocked: false })
  first.emit('closed')
  expect(overlays.input(firstParent)).toMatchObject({ revision: 3, blocked: true })
  expect(firstParent.webContents.listenerCount('before-input-event')).toBe(1)
  second.emit('closed')
  expect(overlays.input(firstParent)).toMatchObject({ revision: 4, blocked: false })
  expect(firstParent.listenerCount('move')).toBe(0)
  expect(firstParent.listenerCount('resize')).toBe(0)
  expect(firstParent.listenerCount('focus')).toBe(0)
  expect(firstParent.webContents.listenerCount('before-input-event')).toBe(0)
  expect(overlays.input(secondParent)).toMatchObject({ revision: 1, blocked: true })
  other.emit('closed')
  expect(overlays.input(secondParent)).toMatchObject({ revision: 2, blocked: false })
})

type EmbeddedParentFixture = EventEmitter & Pick<BrowserWindow, 'getContentBounds' | 'isDestroyed' | 'focus'> & {
  contentView: Pick<BrowserWindow['contentView'], 'addChildView' | 'removeChildView'>
  webContents: EventEmitter
}

function embeddedFixture() {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  // Wayland reports a window origin the overlay must not copy; the view is placed in content coordinates.
  const bounds = { x: 40, y: 21, width: 1000, height: 700 }
  const parentState = { destroyed: false }
  const parent: EmbeddedParentFixture = Object.assign(new EventEmitter(), {
    getContentBounds: () => bounds, focus: vi.fn(), isDestroyed: () => parentState.destroyed,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: new EventEmitter(),
  })
  const contents = Object.assign(new EventEmitter(), {
    destroyed: false,
    focus: vi.fn(), setWindowOpenHandler: vi.fn(), loadURL: vi.fn(async () => {}),
    isDestroyed: () => contents.destroyed,
    close: vi.fn(() => { contents.destroyed = true; contents.emit('destroyed') }),
  })
  const view = { webContents: contents, setBackgroundColor: vi.fn(), setBounds: vi.fn() }
  native.view.mockReturnValue(view)
  const changed = vi.fn()
  const overlays = new DesktopUpdateOverlays(changed)
  const overlay = overlays.create(parent as BrowserWindow, 'owned', 'Update available', false)
  return { bounds, parent, parentState, contents, view, overlays, overlay, changed }
}

it('draws the Linux overlay inside its parent at the parent content size', () => {
  native.create.mockClear()
  const { bounds, parent, contents, view, overlays, overlay } = embeddedFixture()
  expect(native.create).not.toHaveBeenCalled()
  expect(native.view.mock.lastCall?.[0].webPreferences).toMatchObject({
    preload: 'owned', contextIsolation: true, sandbox: true, nodeIntegration: false })
  expect(view.setBackgroundColor).toHaveBeenCalledWith('#00000000')
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1000, height: 700 })
  expect(parent.contentView.addChildView).toHaveBeenCalledWith(view)
  expect(overlays.input(parent as BrowserWindow)).toMatchObject({ revision: 1, blocked: true })
  bounds.width = 1200
  parent.emit('resize')
  expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 700 })
  const event = { preventDefault: vi.fn() }
  parent.webContents.emit('before-input-event', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(contents.focus).toHaveBeenCalledOnce()
  overlay.focus()
  expect(parent.focus).toHaveBeenCalledOnce()
  expect(contents.focus).toHaveBeenCalledTimes(2)
  overlay.destroy()
  overlay.destroy()
  expect(contents.close).toHaveBeenCalledOnce()
})

it('releases a Linux overlay once, whether it closes itself or its parent closes first', () => {
  for (const parentFirst of [false, true]) {
    const { parent, parentState, contents, view, overlays, overlay, changed } = embeddedFixture()
    expect(changed.mock.calls).toEqual([[parent]])
    const closed = vi.fn()
    overlay.once('closed', closed)
    if (parentFirst) { parentState.destroyed = true; parent.emit('closed') }
    else overlay.destroy()
    expect(closed).toHaveBeenCalledOnce()
    expect(overlay.isDestroyed()).toBe(true)
    expect(contents.close).toHaveBeenCalledOnce()
    expect(parent.contentView.removeChildView).toHaveBeenCalledTimes(parentFirst ? 0 : 1)
    if (!parentFirst) expect(parent.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(overlays.input(parent as BrowserWindow)).toMatchObject({ revision: 2, blocked: false })
    for (const event of ['resize', 'focus', 'closed']) expect(parent.listenerCount(event)).toBe(0)
    expect(parent.webContents.listenerCount('before-input-event')).toBe(parentFirst ? 1 : 0)
    contents.emit('destroyed')
    expect(closed).toHaveBeenCalledOnce()
    expect(changed.mock.calls).toEqual([[parent], [parent]])
  }
})

it('shades caption colors as the update backdrop does and leaves other notations alone', () => {
  expect(shadeCaptionColor('rgba(255, 255, 255, 1)')).toBe('rgba(194, 194, 194, 1)')
  expect(shadeCaptionColor('rgb(100, 0, 50)')).toBe('rgba(76, 0, 38, 1)')
  expect(shadeCaptionColor('rgba(255, 255, 255, 0.5)')).toBe('rgba(194, 194, 194, 0.5)')
  expect(shadeCaptionColor('#ffffff')).toBe('#ffffff')
})
