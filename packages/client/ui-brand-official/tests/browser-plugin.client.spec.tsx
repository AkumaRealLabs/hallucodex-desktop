// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { AccountActionView, readDesktopAccountBridge, type DesktopAccountState } from '../src/client/AccountAction.tsx'
import { HALLUCODEX_MARK_PATH, HalluCodexMark, HalluCodexName } from '../src/client/Brand.tsx'
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

function locale() {
  const register = vi.fn((_namespace: string, _dictionaries: unknown) => () => {})
  return { register }
}

async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const dictionaries = locale()
  ctx.provide('locale', dictionaries)
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: {
      ...Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
      [ACCOUNT_HOLE]: { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, dictionaries, declareHoles, disposeHoles }
}

function bridge(initial: DesktopAccountState = { status: 'signed-out' }) {
  let listener: ((state: DesktopAccountState) => void) | undefined
  const unsubscribe = vi.fn()
  const value = {
    subscribe: vi.fn((next: (state: DesktopAccountState) => void) => { listener = next; next(initial); return unsubscribe }),
    open: vi.fn(),
  }
  return { value, unsubscribe, publish: (state: DesktopAccountState) => { listener?.(state) } }
}

const t = (key: keyof typeof zh) => zh[key]

describe('HalluCodex browser-brand plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the slot and locale services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
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

  it('adds the account entry only when the desktop shell exposes its bridge', async () => {
    const web = await bench()
    await web.ctx.plugin({ inject: [...inject], apply }).await()
    expect(web.slots.entries(ACCOUNT_HOLE)).toHaveLength(0)

    vi.stubGlobal('dshHalluCodex', bridge().value)
    const desktop = await bench()
    await desktop.ctx.plugin({ inject: [...inject], apply }).await()
    expect(desktop.slots.entries(ACCOUNT_HOLE)).toHaveLength(1)
  })

  it('accepts only a bridge with both operations', () => {
    expect(readDesktopAccountBridge({})).toBeUndefined()
    expect(readDesktopAccountBridge({ dshHalluCodex: { open() {} } })).toBeUndefined()
    const value = bridge().value
    expect(readDesktopAccountBridge({ dshHalluCodex: value })).toBe(value)
  })

  it('renders the mark at each requested size and the product name', () => {
    const name = render(<HalluCodexName t={t} />)
    expect(name.container.textContent).toBe('HalluCodex')
    name.unmount()

    const mark = render(<HalluCodexMark size={34} className="hero" />)
    const svg = mark.container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('34')
    expect(svg?.getAttribute('class')).toBe('hero')
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe(HALLUCODEX_MARK_PATH)
    mark.rerender(<HalluCodexMark size={24} />)
    expect(mark.container.querySelector('svg')?.getAttribute('width')).toBe('24')
  })

  it('keeps a sign-in entry visible, follows account changes and opens the native dialog', () => {
    const account = bridge()
    const view = render(<AccountActionView wide bridge={account.value} t={t} />)
    const button = view.getByRole('button', { name: '登录 HalluCodex' })
    fireEvent.click(button)
    expect(account.value.open).toHaveBeenCalledOnce()

    act(() => { account.publish({ status: 'signing-in' }) })
    view.getByRole('button', { name: '正在登录…' })
    act(() => { account.publish({ status: 'signed-in', name: 'akuma' }) })
    view.getByRole('button', { name: 'HalluCodex 账号: akuma' })
    expect(view.container.textContent).toBe('Aakuma')

    view.rerender(<AccountActionView wide={false} bridge={account.value} t={t} />)
    expect(view.container.textContent).toBe('A')
    view.unmount()
    expect(account.unsubscribe).toHaveBeenCalledOnce()
  })
})
