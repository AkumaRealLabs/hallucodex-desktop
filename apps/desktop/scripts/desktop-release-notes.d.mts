/** Tag prefix of HalluCodex desktop releases; upstream `dsh-v*` tags are not releases of this application. */
export const DESKTOP_RELEASE_TAG_PREFIX: 'hallucodex-v'

/** Line separating the release notes the application shows from the installation instructions. */
export const DESKTOP_INSTALL_NOTES_MARKER: '<!-- hallucodex:install-notes -->'

/**
 * Read the application version a release tag names.
 * @param tag - Pushed or requested tag, such as `hallucodex-v0.1.0-beta.1`.
 * @returns Version without the prefix, and whether it has a prerelease part.
 */
export function desktopReleaseVersion(tag: string): { readonly version: string, readonly prerelease: boolean }

/**
 * Return the body of the one changelog section headed by a version.
 * @param changelog - Markdown text of `CHANGELOG.md`.
 * @param version - Release version.
 * @returns Section body without its heading, trimmed.
 */
export function desktopChangelogSection(changelog: string, version: string): string

/**
 * Compose the GitHub Release body: changelog section, marker, and install instructions.
 * @param request - Changelog text and release version.
 * @returns Markdown body ending with one newline.
 */
export function desktopReleaseNotes(request: { readonly changelog: string, readonly version: string }): string
