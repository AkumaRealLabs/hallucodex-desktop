import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { HalluCodexKey } from './locales.ts'
import css from './Brand.module.css'
import { HALLUCODEX_MARK_IMAGE } from './mark-image.ts'

/**
 * Render the HalluCodex mark at the edge length requested by its host surface.
 * @param props - Host-supplied size and, in the hero, its geometry class.
 * @returns the decorative logo disk, inset one unit on a 24-unit square; the adjacent name carries the accessible label.
 */
export function HalluCodexMark({ size, className }: SidebarBrandMarkOwnerProps & Partial<Pick<HeroBrandMarkOwnerProps, 'className'>>) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <image href={HALLUCODEX_MARK_IMAGE} x={1} y={1} width={22} height={22} />
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
