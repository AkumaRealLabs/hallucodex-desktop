import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { HalluCodexKey } from './locales.ts'
import css from './Brand.module.css'

/** HalluCodex mark on a 24-unit square: two rounded pillars joined by a rising bridge. */
export const HALLUCODEX_MARK_PATH = 'M5.5 2A2.5 2.5 0 0 1 8 4.5V19.5A2.5 2.5 0 0 1 3 19.5V4.5A2.5 2.5 0 0 1 5.5 2Z'
  + 'M18.5 2A2.5 2.5 0 0 1 21 4.5V19.5A2.5 2.5 0 0 1 16 19.5V4.5A2.5 2.5 0 0 1 18.5 2Z'
  + 'M8 12.4L16 8V11.6L8 16Z'

/**
 * Render the HalluCodex mark at the edge length requested by its host surface.
 * @param props - Host-supplied size and, in the hero, its geometry class.
 * @returns the decorative mark; the adjacent name carries the accessible label.
 */
export function HalluCodexMark({ size, className }: SidebarBrandMarkOwnerProps & Partial<Pick<HeroBrandMarkOwnerProps, 'className'>>) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={HALLUCODEX_MARK_PATH} fill="currentColor" />
    </svg>
  )
}

/**
 * Render the product name beside the independently slotted mark.
 * @param props - The brand namespace's translator.
 * @returns the name text in the brand face.
 */
export function HalluCodexName({ t }: { t: Translate<HalluCodexKey> }) {
  return <span className={css.name}>{t('brand.name')}</span>
}
