/**
 * Enforce intra-package domain layering inside `packages/client/*\/src/client/`.
 * verify-module-graph covers package-level edges; this gate covers the
 * directory level: domain directories may import `contract/` and never each
 * other, and only the assembly point (`apply.ts` / `index.ts`) may import
 * across domains.
 *
 * Layer model (lower may not import higher):
 *   0  contract/            shared contract API (types + slot declarations)
 *   1  <domain>/ + service  domain implementations (skeleton/, chat/, ...)
 *   2  apply.ts, index.ts   assembly point and re-export shell
 *
 * Edges that predate this gate are recorded in `scripts/client-domain-graph.baseline.json`.
 * A new edge fails; a recorded edge that no longer exists also fails until the
 * baseline is pruned, so the inventory only shrinks.
 *
 * Run directly:
 *   pnpm exec tsx scripts/verify-client-domain-graph.ts [--prune]
 */

import { globSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, posix, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const CLIENT_DIR = join(root, 'packages/client')
const BASELINE_PATH = join(root, 'scripts/client-domain-graph.baseline.json')

/** Directory names treated as the shared contract layer (importable by all). */
const CONTRACT_DIRS = new Set(['contract'])
/** Top-level client files allowed to import across domains (assembly layer). */
const ASSEMBLY_FILES = new Set(['apply.ts', 'index.ts', 'index.tsx'])

/** One cross-domain import edge. */
export interface Violation { file: string; imported: string; reason: string }

/** Recorded pre-existing edges: client source path to its imported specifiers. */
export type DomainGraphBaseline = Record<string, string[]>

/** Recursively list .ts/.tsx files under dir (relative paths). */
function listSources(dir: string): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: dir })
    .map(rel => rel.split(sep).join('/'))
    .filter(rel => !/\.legacy\./.test(rel.slice(rel.lastIndexOf('/') + 1)))
    .sort()
}

/** First path segment of a client-relative file, or '' for top-level files. */
function domainOf(rel: string): string {
  const ix = rel.indexOf('/')
  return ix === -1 ? '' : rel.slice(0, ix)
}

/**
 * Resolve one relative import to a client-directory-relative path.
 * @param file - Importing file relative to `src/client`.
 * @param specifier - Relative module specifier from that file.
 * @returns Normalized path, preserving leading `..` segments outside `src/client`.
 */
export function resolveClientImport(file: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(file), specifier))
}

function checkPackage(pkgName: string, clientDir: string): Violation[] {
  const violations: Violation[] = []
  const files = listSources(clientDir)
  for (const rel of files) {
    const fromDomain = domainOf(rel)
    const isAssembly = fromDomain === '' && ASSEMBLY_FILES.has(rel)
    if (isAssembly) continue
    const source = readFileSync(join(clientDir, rel), 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = match[1]
      if (spec === undefined) continue
      const target = resolveClientImport(rel, spec)
      if (target === '..' || target.startsWith('../')) continue // package-level rules govern
      const toDomain = domainOf(target)
      if (toDomain === '' || CONTRACT_DIRS.has(toDomain)) continue // top-level shared file or contract layer
      if (fromDomain === toDomain) continue // inside one domain
      violations.push({
        file: `${pkgName}/src/client/${rel}`,
        imported: spec,
        reason: fromDomain === ''
          ? `top-level non-assembly file imports domain "${toDomain}" (only apply/index may assemble)`
          : `domain "${fromDomain}" imports sibling domain "${toDomain}" (route shared API through contract/)`,
      })
    }
  }
  return violations
}

/**
 * Check every client package below one directory.
 * @param clientRoot - directory holding `<package>/src/client` trees.
 * @returns every cross-domain edge, in package and file order.
 */
export function collectViolations(clientRoot: string): Violation[] {
  const violations: Violation[] = []
  for (const pkg of readdirSync(clientRoot).sort()) {
    const clientDir = join(clientRoot, pkg, 'src/client')
    try {
      if (!statSync(clientDir).isDirectory()) continue
    } catch {
      // No client half in this package — nothing to layer-check.
      continue
    }
    violations.push(...checkPackage(pkg, clientDir))
  }
  return violations
}

/**
 * Group edges into the baseline shape with stable ordering.
 * @param violations - observed edges.
 * @returns file-to-specifier lists sorted for review diffs.
 */
export function baselineOf(violations: readonly Violation[]): DomainGraphBaseline {
  const grouped = new Map<string, Set<string>>()
  for (const { file, imported } of violations) {
    const specifiers = grouped.get(file) ?? new Set<string>()
    specifiers.add(imported)
    grouped.set(file, specifiers)
  }
  return Object.fromEntries([...grouped].sort(([a], [b]) => a.localeCompare(b))
    .map(([file, specifiers]) => [file, [...specifiers].sort()]))
}

function readBaseline(path: string): DomainGraphBaseline {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('verify-client-domain-graph: baseline must be a file-to-imports object')
  }
  const baseline: DomainGraphBaseline = {}
  for (const [file, specifiers] of Object.entries(value)) {
    if (!Array.isArray(specifiers) || !specifiers.every(specifier => typeof specifier === 'string')) {
      throw new Error(`verify-client-domain-graph: invalid baseline entry: ${file}`)
    }
    baseline[file] = specifiers.map(String)
  }
  return baseline
}

/** Outcome of one baseline comparison. */
export interface DomainGraphResult {
  /** Edges absent from the baseline. */
  added: Violation[]
  /** Baseline edges no longer present, as `file -> specifier`. */
  retired: string[]
  /** Recorded edges still present. */
  remaining: number
}

/**
 * Compare observed edges with the recorded inventory, optionally deleting retired entries.
 * @param options.clientRoot - directory holding client packages.
 * @param options.baselinePath - recorded inventory.
 * @param options.prune - rewrite the inventory without retired edges; never records new ones.
 * @returns new edges, retired edges, and the count of recorded edges still present.
 */
export function verifyClientDomainGraph(options: { clientRoot: string; baselinePath: string; prune?: boolean }): DomainGraphResult {
  const baseline = readBaseline(options.baselinePath)
  const violations = collectViolations(options.clientRoot)
  const recorded = new Set(Object.entries(baseline).flatMap(([file, specifiers]) => specifiers.map(spec => `${file} -> ${spec}`)))
  const observed = new Set(violations.map(v => `${v.file} -> ${v.imported}`))
  const added = violations.filter(v => !recorded.has(`${v.file} -> ${v.imported}`))
  const retired = [...recorded].filter(edge => !observed.has(edge)).sort()
  if (options.prune === true && added.length === 0 && retired.length > 0) {
    writeFileSync(options.baselinePath, `${JSON.stringify(baselineOf(violations), null, 2)}\n`)
  }
  return { added, retired, remaining: violations.length - added.length }
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--prune')) {
    console.error('Usage: pnpm run verify-client-domain-graph [--prune]')
    process.exitCode = 1
    return
  }
  const prune = args[0] === '--prune'
  const { added, retired, remaining } = verifyClientDomainGraph({ clientRoot: CLIENT_DIR, baselinePath: BASELINE_PATH, prune })
  if (added.length > 0) {
    console.error(`verify-client-domain-graph: ${String(added.length)} new violation(s):`)
    for (const v of added) console.error(`  ${v.file} -> ${v.imported}\n    ${v.reason}`)
    process.exitCode = 1
    return
  }
  if (retired.length > 0 && !prune) {
    console.error('verify-client-domain-graph: remove retired baseline entries with pnpm run verify-client-domain-graph --prune.')
    for (const edge of retired) console.error(`  ${edge}`)
    process.exitCode = 1
    return
  }
  console.log(remaining === 0
    ? 'verify-client-domain-graph: client domain layering clean.'
    : `verify-client-domain-graph: no new violations; ${String(remaining)} recorded violation(s) remain.`)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
