/** Server-authorized routing groups for the HalluCodex desktop account. */

/** Routing group that sends each request through an ordered list of concrete groups. */
export const AUTO_GROUP = 'auto'

/** One concrete account-allowed group; ratio is descriptive, never a local charge calculation. */
export interface DesktopGroup {
  readonly name: string
  readonly description: string
  readonly ratio: number
}

/** Automatic routing as the site offers it to the account. */
export interface DesktopAutoGroup {
  readonly description: string
  /** Concrete groups, in order, that a device without its own order uses; may be empty. */
  readonly defaultGroups: readonly string[]
  /** Most groups a device's own order may hold. */
  readonly maxGroups: number
}

/** Groups the account may route through. */
export interface DesktopGroups {
  readonly groups: readonly DesktopGroup[]
  /** Null when the site does not offer automatic routing to the account, including servers that predate it. */
  readonly auto: DesktopAutoGroup | null
}

/** A device's routing: a concrete group, or {@link AUTO_GROUP} with its order and retry choice. */
export interface GroupSelection {
  readonly group: string
  /** Concrete groups in the order requests try them; null follows the site's order. Always null for a concrete group. */
  readonly autoGroups: readonly string[] | null
  /** Whether a failed request moves to the next group of the order. Always false for a concrete group. */
  readonly crossGroupRetry: boolean
}

/**
 * Reject implicit inheritance and automatic routing where only one concrete group fits.
 * @param value - group selected by the user or returned by the desktop service.
 * @returns the unchanged concrete group name.
 */
export function concreteGroup(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64
    || value !== value.trim() || value.toLowerCase() === AUTO_GROUP || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('hallucodex: a concrete group is required')
  }
  return value
}

/**
 * Accept a concrete group or exactly {@link AUTO_GROUP}; other spellings of auto stay invalid.
 * @param value - routing group of a grant, stored record, or user selection.
 * @returns the unchanged group name.
 */
export function routingGroup(value: unknown): string {
  return value === AUTO_GROUP ? AUTO_GROUP : concreteGroup(value)
}

/**
 * Require the exact group among the groups the account may route through, with no default or fallback.
 * @param group - explicit selected group.
 * @param allowed - groups returned for the authenticated account, including {@link AUTO_GROUP} when it is offered.
 * @returns the unchanged group after membership validation.
 */
export function allowedGroup(group: unknown, allowed: readonly string[]): string {
  const selected = routingGroup(group)
  for (const candidate of allowed) routingGroup(candidate)
  if (!allowed.includes(selected)) throw new Error('hallucodex: group is not allowed')
  return selected
}

/**
 * Validate an ordered list of distinct concrete groups.
 * @param value - untrusted list.
 * @param max - largest accepted length.
 * @returns a frozen copy.
 */
export function groupOrder(value: unknown, max = 1024): readonly string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('hallucodex: invalid group order')
  const order = value.map(concreteGroup)
  if (new Set(order).size !== order.length) throw new Error('hallucodex: duplicate group')
  return Object.freeze(order)
}

/**
 * Validate a routing choice from an untrusted caller; an automatic order is null or non-empty.
 * @param value - `{ group, autoGroups, crossGroupRetry }`.
 * @returns a frozen selection.
 */
export function groupSelection(value: unknown): GroupSelection {
  if (typeof value !== 'object' || value === null || !('group' in value) || !('autoGroups' in value)
    || !('crossGroupRetry' in value) || typeof value.crossGroupRetry !== 'boolean') throw new Error('hallucodex: invalid group selection')
  const group = routingGroup(value.group)
  const autoGroups = value.autoGroups === null ? null : groupOrder(value.autoGroups)
  if (group !== AUTO_GROUP ? autoGroups !== null || value.crossGroupRetry : autoGroups?.length === 0) {
    throw new Error('hallucodex: invalid group selection')
  }
  return Object.freeze({ group, autoGroups, crossGroupRetry: value.crossGroupRetry })
}

/**
 * Compare two selections; following the site differs from every explicit order.
 * @param left - one selection.
 * @param right - the other selection.
 * @returns whether both route requests identically.
 */
export function sameGroupSelection(left: GroupSelection, right: GroupSelection): boolean {
  return left.group === right.group && left.crossGroupRetry === right.crossGroupRetry
    && (left.autoGroups === null ? right.autoGroups === null
      : right.autoGroups !== null && left.autoGroups.length === right.autoGroups.length
        && left.autoGroups.every((group, index) => right.autoGroups?.[index] === group))
}

function parseAutoGroup(value: unknown): DesktopAutoGroup | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || !('description' in value) || typeof value.description !== 'string' || value.description.length > 1024
    || !('default_groups' in value) || !('max_groups' in value) || typeof value.max_groups !== 'number'
    || !Number.isSafeInteger(value.max_groups) || value.max_groups < 1 || value.max_groups > 1024) {
    throw new Error('hallucodex: invalid automatic group')
  }
  return Object.freeze({ description: value.description, defaultGroups: groupOrder(value.default_groups), maxGroups: value.max_groups })
}

/**
 * Parse the desktop groups DTO.
 * @param value - decoded GET /api/desktop/v1/groups response.
 * @returns immutable account-allowed groups and the automatic routing offer.
 */
export function parseDesktopGroups(value: unknown): DesktopGroups {
  if (typeof value !== 'object' || value === null || !('groups' in value) || !Array.isArray(value.groups)
    || value.groups.length > 1024) throw new Error('hallucodex: invalid groups response')
  const seen = new Set<string>()
  const groups = Object.freeze(value.groups.map((entry: unknown) => {
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
  return Object.freeze({ groups, auto: parseAutoGroup('auto' in value ? value.auto : undefined) })
}
