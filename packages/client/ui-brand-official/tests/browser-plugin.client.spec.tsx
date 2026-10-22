// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { AccountAction, AccountActionView, type AccountActionProps } from '../src/client/AccountAction.tsx'
import { ACCOUNT_PANEL_ID, AccountPage, AccountPageView, type AccountPageProps } from '../src/client/AccountPage.tsx'
import { readDesktopAccountBridge, type DesktopAccountState } from '../src/client/bridge.ts'
import { HalluCodexMark, HalluCodexName } from '../src/client/Brand.tsx'
import { HALLUCODEX_MARK_IMAGE } from '../src/client/mark-image.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const HOLES = [
  'sidebar.brand.mark',
  'sidebar.brand.name',
  'conversation.hero.brand.mark',
] as const

const ACCOUNT_HOLE = 'sidebar.footer.action'
const PAGE_HOLE = 'main'

function locale() {
  const register = vi.fn((_namespace: string, _dictionaries: unknown) => () => {})
  return { register }
}

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const dictionaries = locale()
  ctx.provide('locale', dictionaries)
  const layout = { selectPanel: vi.fn() }
  ctx.provide('layout', layout)
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: {
      ...Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
      [ACCOUNT_HOLE]: { kind: 'list', scope: 'root' },
      [PAGE_HOLE]: { kind: 'keyed', scope: 'root' },
    },
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, dictionaries, layout, declareHoles, disposeHoles }
}

function bridge(initial: DesktopAccountState = { status: 'signed-out' }) {
  let listener: ((state: DesktopAccountState) => void) | undefined
  let opener: (() => void) | undefined
  const unsubscribe = vi.fn()
  const stopOpening = vi.fn()
  const unmount = vi.fn()
  const value = {
    subscribe: vi.fn((next: (state: DesktopAccountState) => void) => { listener = next; next(initial); return unsubscribe }),
    onOpen: vi.fn((next: () => void) => { opener = next; return stopOpening }),
    mount: vi.fn((_head: HTMLElement, _content: HTMLElement) => unmount),
  }
  return {
    value, unsubscribe, stopOpening, unmount,
    publish: (state: DesktopAccountState) => { listener?.(state) },
    requestOpen: () => { opener?.() },
  }
}

const t = (key: keyof typeof zh) => zh[key]

describe('HalluCodex browser-brand plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the slot, locale and layout services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'layout'])
  })

  it('fills every brand declaration before or after apply in every build profile and removes them on teardown', async () => {
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)
    expect(before.dictionaries.register).toHaveBeenCalledWith(NS, { zh, en })

    before.disposeHoles?.()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
    before.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)

    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
  })

  it('adds the account entry and page only when the desktop shell exposes its bridge', async () => {
    const web = await bench()
    await web.ctx.plugin({ inject: [...inject], apply }).await()
    expect(web.slots.entries(ACCOUNT_HOLE)).toHaveLength(0)
    expect(web.slots.entries(PAGE_HOLE)).toHaveLength(0)

    vi.stubGlobal('dshHalluCodex', bridge().value)
    const desktop = await bench()
    await desktop.ctx.plugin({ inject: [...inject], apply }).await()
    expect(desktop.slots.entries(ACCOUNT_HOLE)).toHaveLength(1)
    expect(desktop.slots.entries(PAGE_HOLE).map(entry => entry.options.key)).toEqual([ACCOUNT_PANEL_ID])
    // Each occupant's injected face carries the bridge; the entry's also selects the page.
    const value = (globalThis as { dshHalluCodex?: unknown }).dshHalluCodex
    const injected = (hole: typeof PAGE_HOLE | typeof ACCOUNT_HOLE) =>
      (desktop.slots.entries(hole)[0]!.inject as () => Record<string, unknown>)()
    expect(injected(PAGE_HOLE)).toEqual({ bridge: value })
    const entry = injected(ACCOUNT_HOLE) as { bridge: unknown; openPage(): void }
    expect(entry.bridge).toBe(value)
    entry.openPage()
    expect(desktop.layout.selectPanel).toHaveBeenCalledWith(ACCOUNT_PANEL_ID)
  })

  it('shows the account page on the shell request once the page is registered and stops listening on teardown', async () => {
    const account = bridge()
    vi.stubGlobal('dshHalluCodex', account.value)
    const desktop = await bench(false)
    const fiber = desktop.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(account.value.onOpen).not.toHaveBeenCalled()
    desktop.declareHoles()
    await Promise.resolve()
    expect(account.value.onOpen).toHaveBeenCalledOnce()
    account.requestOpen()
    expect(desktop.layout.selectPanel).toHaveBeenCalledWith(ACCOUNT_PANEL_ID)
    await fiber.dispose()
    expect(account.stopOpening).toHaveBeenCalledOnce()
    expect(desktop.slots.entries(PAGE_HOLE)).toHaveLength(0)
  })

  it('accepts only a bridge with every page operation', () => {
    expect(readDesktopAccountBridge({})).toBeUndefined()
    expect(readDesktopAccountBridge({ dshHalluCodex: { subscribe() {}, open() {} } })).toBeUndefined()
    const value = bridge().value
    expect(readDesktopAccountBridge({ dshHalluCodex: value })).toBe(value)
  })

  it('hands its head and content hosts to the shell while mounted and keeps the head draggable', () => {
    const account = bridge()
    const view = render(<AccountPageView bridge={account.value} />)
    expect(account.value.mount).toHaveBeenCalledOnce()
    const [head, content] = account.value.mount.mock.calls[0]!
    expect(head.isConnected && content.isConnected).toBe(true)
    expect(head.closest('header')?.hasAttribute('data-window-drag')).toBe(true)
    expect(content.closest('header')).toBeNull()
    expect(view.container.querySelector('header img')?.getAttribute('src')).toBe(HALLUCODEX_MARK_IMAGE)
    view.unmount()
    expect(account.unmount).toHaveBeenCalledOnce()

    const occupant = render(<AccountPage {...({ bridge: account.value } as AccountPageProps)} />)
    expect(account.value.mount).toHaveBeenCalledTimes(2)
    occupant.unmount()
  })

  it('marks the slot occupant active while the account page is the selected panel', () => {
    const account = bridge({ status: 'signed-in' })
    const selected = { activePanelId: ACCOUNT_PANEL_ID }
    const usePanelInfo = <T,>(select: (info: typeof selected) => T): T => select(selected)
    const props = { wide: true, bridge: account.value, openPage: vi.fn(), usePanelInfo, t } as AccountActionProps
    const view = render(<AccountAction {...props} />)
    const button = view.getByRole('button')
    expect(button.getAttribute('aria-current')).toBe('page')
    // A signed-in summary without a name shows the generic label and icon.
    expect(button.getAttribute('aria-label')).toBe('HalluCodex 账号: HalluCodex 账号')
    expect(view.container.querySelector('svg')).not.toBeNull()
  })

  it('renders the mark at each requested size and the product name', () => {
    const name = render(<HalluCodexName t={t} />)
    expect(name.container.textContent).toBe('HalluCodex')
    name.unmount()

    const mark = render(<HalluCodexMark size={34} className="hero" />)
    const svg = mark.container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('34')
    expect(svg?.getAttribute('class')).toBe('hero')
    expect(svg?.querySelector('image')?.getAttribute('href')).toBe(HALLUCODEX_MARK_IMAGE)
    mark.rerender(<HalluCodexMark size={24} />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('24')
  })

  it('keeps a sign-in entry visible, follows account changes and selects the account page', () => {
    const account = bridge()
    const openPage = vi.fn()
    const view = render(<AccountActionView wide active={false} bridge={account.value} openPage={openPage} t={t} />)
    const button = view.getByRole('button', { name: '登录 HalluCodex' })
    expect(button.getAttribute('aria-current')).toBeNull()
    fireEvent.click(button)
    expect(openPage).toHaveBeenCalledOnce()

    act(() => { account.publish({ status: 'signing-in' }) })
    view.getByRole('button', { name: '正在登录…' })
    act(() => { account.publish({ status: 'signed-in', name: 'akuma' }) })
    view.getByRole('button', { name: 'HalluCodex 账号: akuma' })
    expect(view.container.textContent).toBe('Aakuma')

    view.rerender(<AccountActionView wide={false} active bridge={account.value} openPage={openPage} t={t} />)
    expect(view.container.textContent).toBe('A')
    expect(view.getByRole('button').getAttribute('aria-current')).toBe('page')
    view.unmount()
    expect(account.unsubscribe).toHaveBeenCalledOnce()
  })
})
