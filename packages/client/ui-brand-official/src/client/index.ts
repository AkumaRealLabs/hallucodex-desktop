/** HalluCodex occupants for the generic brand slots, plus the desktop account entry. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AccountAction, readDesktopAccountBridge, type AccountActionFace } from './AccountAction.tsx'
import { HalluCodexMark, HalluCodexName } from './Brand.tsx'
import { en, NS, zh } from './locales.ts'

export type { AccountActionFace, DesktopAccountBridge, DesktopAccountState } from './AccountAction.tsx'
export type { HalluCodexKey } from './locales.ts'

/** Required services: the UI slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Brand the sidebar and conversation hero as HalluCodex in every build profile and,
 * when the desktop shell exposes its account bridge, keep an account entry above Settings.
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
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'hallucodex-account',
    locale: NS,
    inject: (): AccountActionFace => ({ bridge }),
  }, AccountAction))
}
