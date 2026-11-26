import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopUpdateOverlays, shadeCaptionColor } from '../src/update-overlay.ts'

const native = vi.hoisted(() => ({ create: vi.fn<(options: object) => object>() }))
vi.mock('electron', () => ({ WebContentsView: function (options: object) { return native.create(options) } }))
afterEach(() => { vi.restoreAllMocks() })

function fixture(changed?: (parent: object) => void) {
  let destroyed = false
  const parent = Object.assign(new EventEmitter(), {
    getContentBounds: () => ({ x: 50, y: 40, width: 900, height: 650 }), isDestroyed: () => destroyed,
    isFocused: vi.fn(() => false), focus: vi.fn(), show: vi.fn(),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: Object.assign(new EventEmitter(), { focus: vi.fn() }),
    destroy() { destroyed = true; parent.emit('closed') },
  })
  const views: ReturnType<typeof view>[] = []
  function view() {
    let closed = false
    const webContents = Object.assign(new EventEmitter(), { focus: vi.fn(), isDestroyed: () => closed,
      loadURL: vi.fn(async () => {}), setWindowOpenHandler: vi.fn(),
      close: vi.fn(() => { if (!closed) { closed = true; webContents.emit('destroyed') } }),
    })
    return { get webContents() { if (closed) throw new Error('Destroyed native view'); return webContents },
      setBounds: vi.fn(), setBackgroundColor: vi.fn() }
  }
  native.create.mockImplementation(() => { const next = view(); views.push(next); return next })
  const overlays = new DesktopUpdateOverlays(changed)
  const owner = parent
  return { parent, owner, views, overlays, create: () => overlays.create(owner, 'isolated-preload') }
}

it('never shows or activates its native owner on visibility or background loading', () => {
  const f = fixture(); const overlay = f.create()
  expect(f.parent.contentView.addChildView).toHaveBeenCalledWith(f.views[0])
  f.parent.emit('show'); f.parent.emit('hide'); f.parent.emit('show')
  overlay.webContents.emit('did-finish-load')
  expect(f.parent.show).not.toHaveBeenCalled()
  expect(f.parent.focus).not.toHaveBeenCalled()
  expect(f.views[0]!.webContents.focus).not.toHaveBeenCalled()
  expect(f.parent.listenerCount('show')).toBe(0)
  overlay.destroy()
})

it.each(['darwin', 'win32', 'linux'] as const)('fits inside the owner with native caption clearance on %s', (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  const f = fixture(); const overlay = f.create(); const top = platform === 'win32' ? 40 : 0
  expect(f.views[0]!.setBounds).toHaveBeenCalledWith({ x: 0, y: top, width: 900, height: 650 - top })
  f.parent.emit('resize'); expect(f.views[0]!.setBounds).toHaveBeenCalledTimes(2)
  overlay.destroy()
  expect(f.parent.listenerCount('resize')).toBe(0)
})

it('blocks keyboard input and redirects focus only while the owner is focused', () => {
  const f = fixture(); const overlay = f.create(); const event = { preventDefault: vi.fn() }
  f.parent.webContents.emit('before-input-event', event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(f.views[0]!.webContents.focus).not.toHaveBeenCalled()
  f.parent.isFocused.mockReturnValue(true); f.parent.emit('focus')
  expect(f.views[0]!.webContents.focus).toHaveBeenCalledOnce()
  overlay.destroy()
  expect(f.parent.webContents.focus).toHaveBeenCalledOnce()
  expect(f.parent.webContents.listenerCount('before-input-event')).toBe(0)
})

it('keeps input blocked until every view is released and changes the shortcut revision', () => {
  const f = fixture(); const first = f.create(); const second = f.create()
  expect(f.overlays.input(f.owner)).toEqual({ blocked: true, revision: 2 })
  first.destroy(); expect(f.overlays.input(f.owner)).toEqual({ blocked: true, revision: 3 })
  first.destroy(); second.destroy()
  expect(f.overlays.input(f.owner)).toEqual({ blocked: false, revision: 4 })
  expect(new DesktopUpdateOverlays().input(f.owner)).toEqual({ blocked: false, revision: 0 })
})

it('closes the view after owner destruction without accessing destroyed native contents', () => {
  const f = fixture(); const overlay = f.create()
  Object.defineProperty(f.parent, 'webContents', { get() { throw new Error('Destroyed owner') } })
  expect(() => { f.parent.destroy() }).not.toThrow()
  expect(overlay.isDestroyed()).toBe(true)
  expect(f.parent.listenerCount('focus')).toBe(0)
  expect(f.parent.listenerCount('closed')).toBe(0)
  expect(f.parent.contentView.removeChildView).not.toHaveBeenCalled()
})

it('notifies overlay changes once on attach and once on release, whether view or parent closes first', () => {
  for (const parentFirst of [false, true]) {
    const changed = vi.fn()
    const f = fixture(changed)
    const overlay = f.create()
    expect(changed.mock.calls).toEqual([[f.owner]])
    const contents = overlay.webContents
    if (parentFirst) f.parent.destroy()
    else overlay.destroy()
    overlay.destroy()
    contents.emit('destroyed')
    expect(changed.mock.calls).toEqual([[f.owner], [f.owner]])
  }
})

it('shades caption colors as the update backdrop does and leaves other notations alone', () => {
  expect(shadeCaptionColor('rgba(255, 255, 255, 1)')).toBe('rgba(194, 194, 194, 1)')
  expect(shadeCaptionColor('rgb(100, 0, 50)')).toBe('rgba(76, 0, 38, 1)')
  expect(shadeCaptionColor('rgba(255, 255, 255, 0.5)')).toBe('rgba(194, 194, 194, 0.5)')
  expect(shadeCaptionColor('#ffffff')).toBe('#ffffff')
})
