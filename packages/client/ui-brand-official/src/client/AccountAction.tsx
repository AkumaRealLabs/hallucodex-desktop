import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { IconUserOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { HalluCodexKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { DesktopAccountBridge, DesktopAccountState } from './bridge.ts'
import { ACCOUNT_PANEL_ID } from './AccountPage.tsx'
import css from './AccountAction.module.css'

/** Injected face of the sidebar account action. */
export interface AccountActionFace {
  bridge: DesktopAccountBridge
  /** Select the account page in the main column. */
  openPage: () => void
}

/** Props of the sidebar account action occupant. */
export type AccountActionProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<AccountActionFace> & PropsLocale<'hallucodex'>

/** Props of the account entry's presentation, independent of the slot runtime. */
export interface AccountActionViewProps {
  /** Whether the sidebar is expanded; the collapsed rail shows only the avatar or icon. */
  wide: boolean
  /** Whether the account page is the selected main panel. */
  active: boolean
  bridge: DesktopAccountBridge
  openPage: () => void
  t: Translate<HalluCodexKey>
}

/**
 * Sidebar-foot entry occupant; it forwards only what the presentation reads.
 * @param props - Slot runtime props with the injected bridge and localized copy.
 * @returns the account trigger row.
 */
export function AccountAction({ wide, bridge, openPage, usePanelInfo, t }: AccountActionProps) {
  const active = usePanelInfo(info => info.activePanelId === ACCOUNT_PANEL_ID)
  return <AccountActionView wide={wide} active={active} bridge={bridge} openPage={openPage} t={t} />
}

/**
 * Sidebar-foot entry that selects the account page and marks it while shown.
 * @param props - Sidebar width, page selection, desktop bridge and localized copy.
 * @returns the account trigger row.
 */
export function AccountActionView({ wide, active, bridge, openPage, t }: AccountActionViewProps) {
  const [state, setState] = useState<DesktopAccountState>({ status: 'signed-out' })
  useEffect(() => bridge.subscribe(setState), [bridge])
  let label = t('account.signIn')
  if (state.status === 'signing-in') label = t('account.signingIn')
  else if (state.status === 'signed-in') label = state.name ?? t('account.open')
  const initial = state.status === 'signed-in' && state.name !== undefined ? Array.from(state.name)[0] : undefined
  return (
    <div className={clsx(css.row, !wide && css.railRow)}>
      <Tooltip label={label} disabled={wide}>
        <button
          type="button"
          className={clsx(css.trigger, !wide && css.rail, active && css.active)}
          aria-label={state.status === 'signed-in' ? `${t('account.open')}: ${label}` : label}
          aria-current={active ? 'page' : undefined}
          onClick={openPage}
        >
          {initial === undefined
            ? <IconUserOutlineRegular className={css.icon} size={16} />
            : <span className={css.avatar} aria-hidden="true">{initial.toUpperCase()}</span>}
          {wide && <span className={css.label}>{label}</span>}
        </button>
      </Tooltip>
    </div>
  )
}
