import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { IconUserOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { HalluCodexKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './AccountAction.module.css'

/** Account summary published by the desktop shell; it never carries credentials. */
export interface DesktopAccountState {
  readonly status: 'signed-out' | 'signing-in' | 'signed-in'
  /** Display name, or the account ID when the name is empty; present only while signed in. */
  readonly name?: string
}

/** Desktop shell bridge exposed by the HalluCodex preload as `window.dshHalluCodex`. */
export interface DesktopAccountBridge {
  /**
   * Receive the current state once known and every later change.
   * @param listener - State observer.
   * @returns Unsubscribe.
   */
  subscribe(listener: (state: DesktopAccountState) => void): () => void
  /** Open the native account dialog. */
  open(): void
}

/** Injected face of the sidebar account action. */
export interface AccountActionFace {
  bridge: DesktopAccountBridge
}

/** Props of the sidebar account action occupant. */
export type AccountActionProps = PropsRuntime<'sidebar.footer.action'> & InjectFace<AccountActionFace> & PropsLocale<'hallucodex'>

/**
 * Read the desktop account bridge; the Web client has none and shows no account entry.
 * @param scope - Global object the preload exposes the bridge on.
 * @returns The bridge when both of its operations are present.
 */
export function readDesktopAccountBridge(scope: object): DesktopAccountBridge | undefined {
  const candidate: unknown = Reflect.get(scope, 'dshHalluCodex')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  if (typeof Reflect.get(candidate, 'subscribe') !== 'function' || typeof Reflect.get(candidate, 'open') !== 'function') return undefined
  return candidate as DesktopAccountBridge
}

/** Props of the account entry's presentation, independent of the slot runtime. */
export interface AccountActionViewProps {
  /** Whether the sidebar is expanded; the collapsed rail shows only the avatar or icon. */
  wide: boolean
  bridge: DesktopAccountBridge
  t: Translate<HalluCodexKey>
}

/**
 * Sidebar-foot entry occupant; it forwards only what the presentation reads.
 * @param props - Slot runtime props with the injected bridge and localized copy.
 * @returns the account trigger row.
 */
export function AccountAction({ wide, bridge, t }: AccountActionProps) {
  return <AccountActionView wide={wide} bridge={bridge} t={t} />
}

/**
 * Sidebar-foot entry that stays visible after the account dialog closes.
 * @param props - Sidebar width, desktop bridge and localized copy.
 * @returns the account trigger row.
 */
export function AccountActionView({ wide, bridge, t }: AccountActionViewProps) {
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
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label={state.status === 'signed-in' ? `${t('account.open')}: ${label}` : label}
          aria-haspopup="dialog"
          onClick={() => { bridge.open() }}
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
