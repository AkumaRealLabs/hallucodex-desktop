import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { resolveClientImport, verifyClientDomainGraph } from './verify-client-domain-graph.ts'

describe('client domain import resolution', () => {
  it('preserves imports that leave src/client from a top-level file', () => {
    expect(resolveClientImport('styles.ts', '../styles/base.css?inline'))
      .toBe('../styles/base.css?inline')
  })

  it('normalizes imports between domains inside src/client', () => {
    expect(resolveClientImport('input/hub.ts', '../queue/store.ts'))
      .toBe('queue/store.ts')
  })
})

describe('client domain graph baseline', () => {
  function fixture(baseline: Record<string, string[]>) {
    const clientRoot = mkdtempSync(join(tmpdir(), 'client-domain-graph-'))
    onTestFinished(() => { rmSync(clientRoot, { recursive: true, force: true }) })
    const client = join(clientRoot, 'ui-example', 'src', 'client')
    mkdirSync(join(client, 'rows'), { recursive: true })
    mkdirSync(join(client, 'actions'), { recursive: true })
    writeFileSync(join(client, 'rows', 'Rows.ts'), 'export const rows = 1\n')
    const baselinePath = join(clientRoot, 'baseline.json')
    writeFileSync(baselinePath, `${JSON.stringify(baseline)}\n`)
    const importRows = (enabled: boolean) => {
      const source = enabled ? "import { rows } from '../rows/Rows.ts'\nexport const archive = rows\n" : 'export const archive = 1\n'
      writeFileSync(join(client, 'actions', 'Archive.ts'), source)
    }
    return { clientRoot, baselinePath, importRows }
  }
  const EDGE = { 'ui-example/src/client/actions/Archive.ts': ['../rows/Rows.ts'] }

  it('fails a new cross-domain import and never records it while pruning', () => {
    const f = fixture({})
    f.importRows(true)
    const result = verifyClientDomainGraph({ clientRoot: f.clientRoot, baselinePath: f.baselinePath, prune: true })
    expect(result.added.map(v => `${v.file} -> ${v.imported}`)).toEqual(['ui-example/src/client/actions/Archive.ts -> ../rows/Rows.ts'])
    expect(JSON.parse(readFileSync(f.baselinePath, 'utf8'))).toEqual({})
  })

  it('accepts a recorded import, then requires pruning once it is fixed', () => {
    const f = fixture(EDGE)
    f.importRows(true)
    const paths = { clientRoot: f.clientRoot, baselinePath: f.baselinePath }
    expect(verifyClientDomainGraph(paths)).toEqual({ added: [], retired: [], remaining: 1 })
    f.importRows(false)
    expect(verifyClientDomainGraph(paths).retired)
      .toEqual(['ui-example/src/client/actions/Archive.ts -> ../rows/Rows.ts'])
    expect(JSON.parse(readFileSync(f.baselinePath, 'utf8'))).toEqual(EDGE)
    verifyClientDomainGraph({ ...paths, prune: true })
    expect(JSON.parse(readFileSync(f.baselinePath, 'utf8'))).toEqual({})
  })
})
