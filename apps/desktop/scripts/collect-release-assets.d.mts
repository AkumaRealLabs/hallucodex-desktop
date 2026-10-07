/** Checksum listing written beside the collected assets. */
export const DESKTOP_RELEASE_CHECKSUMS: 'SHA256SUMS'

/**
 * Collect, merge, verify, and checksum one version's release assets.
 * @param request - Version, input directories, and the empty or new output directory.
 * @returns Collected asset names, sorted, ending with `SHA256SUMS`.
 */
export function collectDesktopReleaseAssets(request: {
  readonly version: string
  readonly inputs: readonly string[]
  readonly output: string
}): Promise<string[]>
