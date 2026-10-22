/** Contract of the desktop account bridge and the reader that finds it; the Web client has none. */

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
  /**
   * Receive the shell's requests to show the account page: the application menu, and a workspace that opens signed out.
   * @param listener - Shows the account page.
   * @returns Stop receiving requests.
   */
  onOpen(listener: () => void): () => void
  /**
   * Render the native account page into the page frame's hosts; the shell owns their content.
   * @param head - Host in the page head row.
   * @param content - Host filling the rest of the page.
   * @returns Unmount; a sign-in in progress continues.
   */
  mount(head: HTMLElement, content: HTMLElement): () => void
}

/**
 * Read the desktop account bridge; the Web client has none and shows no account entry or page.
 * @param scope - Global object the preload exposes the bridge on.
 * @returns The bridge when all of its operations are present.
 */
export function readDesktopAccountBridge(scope: object): DesktopAccountBridge | undefined {
  const candidate: unknown = Reflect.get(scope, 'dshHalluCodex')
  if (typeof candidate !== 'object' || candidate === null) return undefined
  if (!['subscribe', 'onOpen', 'mount'].every(operation => typeof Reflect.get(candidate, operation) === 'function')) return undefined
  return candidate as DesktopAccountBridge
}
