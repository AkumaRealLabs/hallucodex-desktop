import { defineConfig } from 'tsdown'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { repositoryClientBuildEnvironment, resolveClientBuildEnvironment } from '../../scripts/client-build-environment.ts'
import { packagedImportsPlugin } from './scripts/desktop-bundle-imports.mjs'

// This config runs after the workspace tsdown pass, not inside it: the main bundle inlines
// workspace devDependencies from their lib/ output, which the concurrent workspace pass does
// not order ahead of this package (root package.json build:lib:host).
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>
}
/** electron-builder ships the manifest `dependencies` next to the main bundle; Electron provides `electron` and Node. */
const mainProcessImports = { packages: new Set(['electron', ...Object.keys(manifest.dependencies)]), nodeBuiltins: true }
/**
 * The `require` polyfill of a sandboxed preload resolves only these modules
 * (Electron: Process Sandboxing, "Preload scripts").
 */
const preloadImports = { packages: new Set(['electron', 'events', 'timers', 'url']), nodeBuiltins: false }

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Use the client environment this build already received, otherwise the repository's own version and commit. */
const clientEnvironment = resolveClientBuildEnvironment(process.env.DSH_CLIENT_VERSION === undefined
  ? repositoryClientBuildEnvironment(REPOSITORY_ROOT, process.env)
  : process.env)
const clientVersion = clientEnvironment.DSH_CLIENT_VERSION
if (clientVersion === undefined) throw new Error('desktop build: the client environment carries no DSH_CLIENT_VERSION')

/** Inline the one public build value the Node entry reads; every other variable stays a runtime lookup. */
const clientVersionDefine = { 'process.env.DSH_CLIENT_VERSION': JSON.stringify(clientVersion) }

export default defineConfig([
  {
    entry: ['lib/types/command-manager-entry.js'],
    plugins: [packagedImportsPlugin({ packages: new Set(), nodeBuiltins: true })],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    codeSplitting: false,
    deps: { alwaysBundle: ['@deepseek-ai/dsh-atomic-write'] },
  },
  {
    entry: ['lib/types/main.js'],
    plugins: [packagedImportsPlugin(mainProcessImports)],
    define: clientVersionDefine,
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  },
  ...(['preload-app', 'preload-update-dialog'] as const).map(name => ({
    // Sandboxed Electron preloads run as CommonJS even though the application package is ESM.
    entry: { [name]: `lib/types/${name}.js` },
    plugins: [packagedImportsPlugin(preloadImports)],
    outDir: 'lib',
    format: 'cjs' as const,
    codeSplitting: false,
    platform: 'node' as const,
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: ['electron'] },
  })),
])
