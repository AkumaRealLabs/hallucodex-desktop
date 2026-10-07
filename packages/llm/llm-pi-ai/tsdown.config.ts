import { defineConfig } from 'tsdown'

/** Preserve the root adapter API while shipping explicit application-owned profile resolution separately. */
export default defineConfig(['index', 'profiles'].map(name => ({
  entry: ['lib/types/' + name + '.js'],
  outDir: 'lib', format: ['esm'] as const, platform: 'node', target: 'es2024',
  outputOptions: { codeSplitting: false },
  fixedExtension: false, dts: false, clean: false,
})))
