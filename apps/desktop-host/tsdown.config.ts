import { copyFile } from 'node:fs/promises'
import { defineConfig } from 'tsdown'

export default defineConfig(['index', 'cli', 'hallucodex'].map(name => ({
  entry: ['lib/types/' + name + '.js'],
  outDir: 'lib',
  format: ['esm'] as const,
  outputOptions: { codeSplitting: false },
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  onSuccess: name === 'index' ? async () => {
    await copyFile(new URL('./src/hallucodex.patch.yml', import.meta.url), new URL('./lib/hallucodex.patch.yml', import.meta.url))
  } : undefined,
})))
