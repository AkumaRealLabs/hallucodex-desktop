/** Decorative artwork resolves theme tokens to distinct foreground, backing, and detail colors. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parseRules, varReferences } from './stylesheet-scan.ts'

const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/styles/design-platform.css'), 'utf8')
const illustration = readFileSync(resolve(import.meta.dirname, '../../ui-schedule/src/client/ScheduleEmptyIllustration.tsx'), 'utf8')
const rules = parseRules(stylesheet)
const PREFIX = '--dsw-alias-illustration-'
const ROLES = ['background', 'backing', 'detail', 'inset', 'shadow', 'surface'] as const

type Rgb = [number, number, number]

function definitions(dark: boolean): Map<string, string> {
  const selector = dark ? 'body[data-ds-dark-theme]' : 'body'
  return new Map(rules.filter(rule => rule.selectors.includes(selector)).flatMap(rule => rule.declarations))
}

function resolveColor(palette: Map<string, string>, name: string): Rgb {
  const seen = new Set<string>()
  let current = name
  while (palette.has(current) && !seen.has(current)) {
    seen.add(current)
    const value = palette.get(current)!
    const [reference] = varReferences(value)
    if (reference !== undefined) {
      expect(value, current).toMatch(/^var\(\s*--[\w-]+\s*\)$/)
      current = reference
      continue
    }
    const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value)
    expect(rgb, `${name}: ${current} = ${value}`).not.toBeNull()
    return [Number(rgb![1]), Number(rgb![2]), Number(rgb![3])]
  }
  throw new Error(`Unresolved color ${name}: ${current}`)
}

function illustrationColors(palette: Map<string, string>) {
  return Object.fromEntries(ROLES.map(role => [role, resolveColor(palette, `${PREFIX}${role}`)]))
}

function luminance(rgb: Rgb): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function expectDarkLayers(palette: Map<string, string>): void {
  const color = (role: string): Rgb => resolveColor(palette, `${PREFIX}${role}`)
  expect(luminance(color('surface'))).toBeGreaterThan(luminance(color('backing')))
  expect(luminance(color('backing'))).toBeGreaterThan(luminance(color('background')))
  for (const role of ['surface', 'backing', 'background']) expect(color('detail')).not.toEqual(color(role))
  expect(color('inset')).toEqual(color('backing'))
  expect(color('shadow')).toEqual(color('backing'))
}

function expectConsumerColors(source: string, palette: Map<string, string>): void {
  const consumed = new Set(varReferences(source))
  const defined = [...palette.keys()].filter(name => name.startsWith(PREFIX)).sort()
  expect([...consumed].sort()).toEqual(defined)
  expect(consumed.size).toBe(ROLES.length)
  for (const name of consumed) resolveColor(palette, name)
}

const lightColors = {
  background: [245, 240, 232],
  backing: [214, 206, 194],
  detail: [214, 206, 194],
  inset: [239, 233, 222],
  shadow: [239, 233, 222],
  surface: [239, 233, 222],
}

it('preserves the original light artwork colors, including surface-colored insets and shadows', () => {
  expect(illustrationColors(definitions(false))).toEqual(lightColors)
})

it.each([false, true])('defines the approved light static steps in the dark=%s palette', (dark) => {
  const palette = definitions(dark)
  expect(resolveColor(palette, '--dsw-static-neutral-bluish-55')).toEqual([245, 240, 232])
  expect(resolveColor(palette, '--dsw-static-neutral-bluish-90')).toEqual([239, 233, 222])
  expect(resolveColor(palette, '--dsw-static-neutral-bluish-310')).toEqual([214, 206, 194])
})

it('resolves the dark artwork colors through the actual static palette', () => {
  expect(illustrationColors(definitions(true))).toEqual({
    background: [45, 42, 38],
    backing: [58, 51, 45],
    detail: [124, 120, 112],
    inset: [58, 51, 45],
    shadow: [58, 51, 45],
    surface: [108, 106, 100],
  })
})

it('keeps dark surfaces brighter than backing and background, with distinct details and backing-colored insets and shadows', () => {
  expectDarkLayers(definitions(true))
})

it.each([false, true])('resolves the illustration consumer names in the dark=%s palette', (dark) => {
  expectConsumerColors(illustration, definitions(dark))
})

it('rejects light static-color drift even when alias names stay unchanged', () => {
  const palette = definitions(false)
  palette.set('--dsw-static-neutral-bluish-90', 'rgb(235, 238, 242)')
  expect(() => { expect(illustrationColors(palette)).toEqual(lightColors) }).toThrow()
})

it.each([
  ['surface', 'backing'],
  ['backing', 'surface'],
  ['background', 'backing'],
  ['detail', 'surface'],
  ['inset', 'surface'],
  ['shadow', 'surface'],
])('rejects a dark %s role changed to %s', (role, target) => {
  const palette = definitions(true)
  palette.set(`${PREFIX}${role}`, `var(${PREFIX}${target})`)
  expect(() => { expectDarkLayers(palette) }).toThrow()
})

it.each([false, true])('rejects renamed consumers and missing definitions in the dark=%s palette', (dark) => {
  const palette = definitions(dark)
  const renamed = illustration.replaceAll(`${PREFIX}inset`, `${PREFIX}clock-face`)
  expect(() => { expectConsumerColors(renamed, palette) }).toThrow()
  const misspelled = illustration.replace(PREFIX, '--dsw-alias-illustation-')
  expect(() => { expectConsumerColors(misspelled, palette) }).toThrow()
  palette.delete(`${PREFIX}inset`)
  expect(() => { expectConsumerColors(illustration, palette) }).toThrow()
})

it.each(['--dsw-static-missing', `${PREFIX}inset`])('rejects an unresolved or cyclic inset reference to %s', (target) => {
  const palette = definitions(true)
  palette.set(`${PREFIX}inset`, `var(${target})`)
  expect(() => resolveColor(palette, `${PREFIX}inset`)).toThrow('Unresolved color')
})
