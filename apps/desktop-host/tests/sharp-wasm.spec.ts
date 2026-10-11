import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, type ModuleHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { installSharpWasmResolution } from '../src/sharp-wasm.ts'

const roots: string[] = []
const hooks: ModuleHooks[] = []
afterEach(() => {
  for (const hook of hooks.splice(0)) hook.deregister()
  const cache = createRequire(import.meta.url).cache
  for (const path of Object.keys(cache)) {
    if (roots.some(root => path.startsWith(root + sep))) Reflect.deleteProperty(cache, path)
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function packages(names: readonly string[]): (specifier: string) => unknown {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-sharp-resolution-')))
  roots.push(root)
  for (const name of names) {
    mkdirSync(join(root, 'node_modules', name), { recursive: true })
    writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name }))
    writeFileSync(join(root, 'node_modules', name, 'index.js'), `module.exports = ${JSON.stringify(name)}`)
  }
  return createRequire(join(root, 'package.json'))
}

it.each([['darwin', '44.7.0'], ['win32', '44.7.0'], ['linux', undefined]] as const)(
  'installs nothing on %s with Electron %s',
  (platform, electron) => {
    expect(installSharpWasmResolution(platform, electron)).toBeUndefined()
  },
)

it('refuses native Linux sharp packages and keeps other sharp packages resolvable', () => {
  const require = packages(['@img/sharp-linux-x64', '@img/sharp-linuxmusl-arm64', '@img/sharp-libvips-linux-x64',
    '@img/sharp-wasm32', '@img/sharp-darwin-arm64', '@img/sharp-linux-x64-extra'])
  hooks.push(installSharpWasmResolution('linux', '44.7.0')!)
  for (const specifier of ['@img/sharp-linux-x64/package.json', '@img/sharp-linux-x64', '@img/sharp-linuxmusl-arm64/package.json',
    '@img/sharp-libvips-linux-x64/package.json']) {
    expect(() => require(specifier)).toThrow(expect.objectContaining({
      code: 'MODULE_NOT_FOUND', message: `Desktop on Linux loads sharp's WebAssembly build instead of ${specifier}`,
    }))
  }
  expect(require('@img/sharp-wasm32')).toBe('@img/sharp-wasm32')
  expect(require('@img/sharp-darwin-arm64')).toBe('@img/sharp-darwin-arm64')
})

it.runIf(process.platform === 'linux')('loads and runs sharp from its WebAssembly build', () => {
  const attachments = new URL('../../../packages/attachment/attachment-local/package.json', import.meta.url)
  const script = `
    import { createRequire } from 'node:module'
    import { installSharpWasmResolution } from ${JSON.stringify(new URL('../src/sharp-wasm.ts', import.meta.url).href)}
    installSharpWasmResolution('linux', 'fixture')
    const require = createRequire(${JSON.stringify(attachments.href)})
    const sharp = require('sharp')
    const png = await sharp(Buffer.alloc(12, 128), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer()
    const { width, format } = await sharp(png).metadata()
    const bindings = [...new Set(Object.keys(require.cache).flatMap(path => /[/]@img[/](sharp-[^/]+)[/][^@]*$/u.exec(path)?.[1] ?? []))]
    console.log(JSON.stringify({ width, format, bindings }))
    process.exit(0)
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 60_000 })
  const result = JSON.parse(output) as { width: number; format: string; bindings: string[] }
  expect(result.width).toBe(2)
  expect(result.format).toBe('png')
  expect(result.bindings).toEqual(['sharp-wasm32'])
})
