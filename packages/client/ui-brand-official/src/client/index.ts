/** HalluCodex occupants for the generic brand slots, plus the desktop account entry and page. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AccountAction, type AccountActionFace } from './AccountAction.tsx'
import { ACCOUNT_PANEL_ID, AccountPage, type AccountPageFace } from './AccountPage.tsx'
import { readDesktopAccountBridge } from './bridge.ts'
import { HalluCodexMark, HalluCodexName } from './Brand.tsx'
import { en, NS, zh } from './locales.ts'

export type { AccountActionFace } from './AccountAction.tsx'
export type { AccountPageFace } from './AccountPage.tsx'
export type { DesktopAccountBridge, DesktopAccountState } from './bridge.ts'
export type { HalluCodexKey } from './locales.ts'

/** Required services: the UI slot registry, the locale registry, and the layout that selects the account page. */
export const inject = ['slots', 'locale', 'layout']

/**
 * Brand the sidebar and conversation hero as HalluCodex in every build profile and,
 * when the desktop shell exposes its account bridge, add the account page with its entry above Settings.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'hallucodex: dictionaries')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, HalluCodexMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', locale: NS }, HalluCodexName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, HalluCodexMark))
  const bridge = readDesktopAccountBridge(globalThis)
  if (bridge === undefined) return
  const openPage = (): void => { ctx.layout.selectPanel(ACCOUNT_PANEL_ID) }
  // The shell's open requests follow the page's registration, so a request kept before it selects a registered panel.
  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: ACCOUNT_PANEL_ID, inject: (): AccountPageFace => ({ bridge }) }, AccountPage)
    yield bridge.onOpen(openPage)
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'hallucodex-account',
    locale: NS,
    inject: (): AccountActionFace => ({ bridge, openPage }),
  }, AccountAction))
}
