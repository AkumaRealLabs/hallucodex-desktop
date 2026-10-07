/** Concrete server-authorized routing groups for the HalluCodex desktop account. */

/** One concrete account-allowed group; ratio is descriptive, never a local charge calculation. */
export interface DesktopGroup {
  readonly name: string
  readonly description: string
  readonly ratio: number
}

/**
 * Reject implicit inheritance and automatic routing at every desktop request entry.
 * @param value - group selected by the user or returned by the desktop service.
 * @returns the unchanged concrete group name.
 */
export function concreteGroup(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64
    || value !== value.trim() || value.toLowerCase() === 'auto' || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('hallucodex: a concrete group is required')
  }
  return value
}

/**
 * Require a fresh server grant for the exact group, with no default or fallback.
 * @param group - explicit selected group.
 * @param allowed - concrete groups returned for the authenticated account.
 * @returns the unchanged group after membership validation.
 */
export function allowedGroup(group: unknown, allowed: readonly string[]): string {
  const selected = concreteGroup(group)
  for (const candidate of allowed) concreteGroup(candidate)
  if (!allowed.includes(selected)) throw new Error('hallucodex: group is not allowed')
  return selected
}

/**
 * Parse the desktop groups DTO; the general site's automatic-group default is not consumed.
 * @param value - decoded GET /api/desktop/v1/groups response.
 * @returns immutable account-allowed groups.
 */
export function parseDesktopGroups(value: unknown): readonly DesktopGroup[] {
  if (typeof value !== 'object' || value === null || !('groups' in value) || !Array.isArray(value.groups)
    || value.groups.length > 1024) throw new Error('hallucodex: invalid groups response')
  const seen = new Set<string>()
  return Object.freeze(value.groups.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || !('name' in entry) || !('description' in entry)
      || typeof entry.description !== 'string' || entry.description.length > 1024 || !('ratio' in entry)
      || typeof entry.ratio !== 'number' || !Number.isFinite(entry.ratio) || entry.ratio < 0) {
      throw new Error('hallucodex: invalid group')
    }
    const name = concreteGroup(entry.name)
    if (seen.has(name)) throw new Error('hallucodex: duplicate group')
    seen.add(name)
    return Object.freeze({ name, description: entry.description, ratio: entry.ratio })
  }))
}
