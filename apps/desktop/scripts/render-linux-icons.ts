/**
 * Render the Linux application icon set from `resources/icon-windows.svg`, the same rounded tile as Windows.
 *
 * Desktop environments resolve the desktop entry's `Icon=hallucodex` through
 * the hicolor theme, which searches only the sizes its index lists; a single
 * oversized bitmap lands in an unlisted directory and menus show a generic icon.
 * electron-builder installs each `<edge>x<edge>.png` of the output directory
 * into the matching hicolor size, and each size is rasterized from the vector
 * source separately so small icons stay crisp. The committed
 * `resources/linux-icons/` is the output; rerun `pnpm run render:linux-icons`
 * in `apps/desktop` after changing the vector source.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Bitmap edges installed under hicolor; every one is a size the hicolor theme index lists. */
export const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const

/** Vector source and committed output directory of the Linux icon set. */
export const LINUX_ICON_PATHS = {
  source: fileURLToPath(new URL('../resources/icon-windows.svg', import.meta.url)),
  output: fileURLToPath(new URL('../resources/linux-icons', import.meta.url)),
} as const

/** Canvas edge of the vector source; sharp's SVG density is scaled against it. */
const SOURCE_EDGE = 1024
const SOURCE_DENSITY = 72

async function main(): Promise<void> {
  const svg = await readFile(LINUX_ICON_PATHS.source)
  await rm(LINUX_ICON_PATHS.output, { recursive: true, force: true })
  await mkdir(LINUX_ICON_PATHS.output)
  for (const size of LINUX_ICON_SIZES) {
    const png = await sharp(svg, { density: SOURCE_DENSITY * size / SOURCE_EDGE }).resize(size, size).png().toBuffer()
    await writeFile(join(LINUX_ICON_PATHS.output, `${String(size)}x${String(size)}.png`), png)
  }
  console.info(`linux icons: wrote ${LINUX_ICON_SIZES.map(String).join(', ')} px bitmaps to ${LINUX_ICON_PATHS.output}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
