/** Device label shown in the website's desktop device list. */

const SYSTEMS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

/**
 * Name this computer so its owner can tell devices apart; the server accepts 128 bytes without control characters.
 * @param hostname - Operating-system host name.
 * @param platform - Native platform.
 * @param arch - Native architecture.
 * @returns Host name followed by system and architecture, truncated on a character boundary.
 */
export function desktopDeviceName(hostname: string, platform: NodeJS.Platform, arch: string): string {
  const suffix = ` · ${SYSTEMS[platform] ?? platform} ${arch}`
  // Truncate by grapheme so a host name never ends in half of a character.
  let name = Array.from(new Intl.Segmenter().segment(hostname.replace(/[\u0000-\u001f\u007f]/gu, '').trim()), part => part.segment)
  while (name.length > 0 && Buffer.byteLength(name.join('') + suffix) > 128) name = name.slice(0, -1)
  return `${name.length > 0 ? name.join('').trim() : 'HalluCodex'}${suffix}`
}
