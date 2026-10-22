import { useEffect, useRef } from 'react'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopAccountBridge } from './bridge.ts'
import { HALLUCODEX_MARK_IMAGE } from './mark-image.ts'
import css from './AccountPage.module.css'

/** Main panel key of the desktop account page; the sidebar account entry and the shell's open requests select it. */
export const ACCOUNT_PANEL_ID = 'hallucodex-account' as MainPanelId

/** Injected face of the account page. */
export interface AccountPageFace {
  bridge: DesktopAccountBridge
}

/** Props of the account page occupant. */
export type AccountPageProps = PropsRuntime<'main'> & InjectFace<AccountPageFace>

/**
 * Main-panel occupant; it forwards only the bridge to the presentation.
 * @param props - Slot runtime props with the injected bridge.
 * @returns the account page frame.
 */
export function AccountPage({ bridge }: AccountPageProps) {
  return <AccountPageView bridge={bridge} />
}

/**
 * Page frame whose head and content hosts the desktop shell fills with the account page while it is shown.
 * @param props - Desktop account bridge.
 * @returns the page frame; the shell renders the account text and controls inside it.
 */
export function AccountPageView({ bridge }: { bridge: DesktopAccountBridge }) {
  const head = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  // React attaches both refs before effects run.
  useEffect(() => bridge.mount(head.current as HTMLDivElement, content.current as HTMLDivElement), [bridge])
  return (
    <div className={css.page}>
      <header className={css.pageHead} data-window-drag>
        <img className={css.mark} src={HALLUCODEX_MARK_IMAGE} width={24} height={24} alt="" />
        <div ref={head} className={css.headHost} />
      </header>
      <div ref={content} className={css.content} />
    </div>
  )
}
