import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_INSTALL_NOTES_MARKER,
  desktopChangelogSection,
  desktopReleaseNotes,
  desktopReleaseVersion,
} from '../scripts/desktop-release-notes.mjs'

const CHANGELOG = `# 更新日志

## [Unreleased]

- 尚未发布

## 0.1.0-beta.1 - 2026-10-01

- 测试版

## 0.1.0

### 新增

- 浏览器授权

### 修复

- 设备名称
`

describe('HalluCodex release tags', () => {
  it.each([
    ['hallucodex-v0.1.0', '0.1.0', false],
    ['hallucodex-v0.1.0-beta.1', '0.1.0-beta.1', true],
    ['hallucodex-v1.12.3-rc.0.1', '1.12.3-rc.0.1', true],
  ] as const)('reads %s as version %s', (tag, version, prerelease) => {
    expect(desktopReleaseVersion(tag)).toEqual({ version, prerelease })
  })

  it.each(['dsh-v0.2.1-alpha.1', 'v0.1.0', 'hallucodex-0.1.0', 'hallucodex-v0.1', 'hallucodex-v01.0.0',
    'hallucodex-v0.1.0+build.1', 'hallucodex-v0.1.0-beta..1', 'hallucodex-v0.1.0-01'])('rejects %s', (tag) => {
    expect(() => desktopReleaseVersion(tag)).toThrow(/desktop release/u)
  })
})

describe('HalluCodex release notes', () => {
  it('extracts exactly the section of the released version', () => {
    expect(desktopChangelogSection(CHANGELOG, '0.1.0')).toBe('### 新增\n\n- 浏览器授权\n\n### 修复\n\n- 设备名称')
    expect(desktopChangelogSection(CHANGELOG, '0.1.0-beta.1')).toBe('- 测试版')
    expect(desktopChangelogSection(CHANGELOG.replaceAll('\n', '\r\n'), '0.1.0-beta.1')).toBe('- 测试版')
  })

  it.each([
    ['a missing section', CHANGELOG, '0.2.0', /exactly one "## 0\.2\.0" section, found 0/u],
    ['a duplicated section', `${CHANGELOG}\n## 0.1.0\n\n- again\n`, '0.1.0', /found 2/u],
    ['an empty section', '## 0.3.0\n\n## 0.2.0\n\n- x\n', '0.3.0', /section 0\.3\.0 is empty/u],
  ])('fails the release for %s', (_label, changelog, version, error) => {
    expect(() => desktopReleaseNotes({ changelog, version })).toThrow(error)
  })

  it('puts the changelog first and the install instructions after one marker', () => {
    const notes = desktopReleaseNotes({ changelog: CHANGELOG, version: '0.1.0' })
    expect(notes.startsWith('### 新增\n\n- 浏览器授权')).toBe(true)
    expect(notes.split(DESKTOP_INSTALL_NOTES_MARKER)).toHaveLength(2)
    const [shown, install] = notes.split(DESKTOP_INSTALL_NOTES_MARKER)
    expect(shown).not.toContain('xattr')
    expect(install).toContain('xattr -dr com.apple.quarantine /Applications/HalluCodex.app')
    expect(install).toContain('仍要运行')
    expect(install).toContain('Run anyway')
    expect(notes.endsWith('\n')).toBe(true)
    expect(() => desktopReleaseNotes({ changelog: `## 0.1.0\n\n- ${DESKTOP_INSTALL_NOTES_MARKER}\n`, version: '0.1.0' }))
      .toThrow(/must not contain/u)
  })

  it('serves the release workflow through its command line', async () => {
    const script = new URL('../scripts/desktop-release-notes.mjs', import.meta.url).pathname
    expect(execFileSync(process.execPath, [script, 'version', 'hallucodex-v0.1.0-beta.1'], { encoding: 'utf8' }))
      .toBe('version=0.1.0-beta.1\nprerelease=true\n')
    const directory = await mkdtemp(join(tmpdir(), 'desktop-release-notes-'))
    try {
      await writeFile(join(directory, 'CHANGELOG.md'), CHANGELOG)
      execFileSync(process.execPath, [script, 'notes', '--version', '0.1.0', '--changelog', join(directory, 'CHANGELOG.md'),
        '--output', join(directory, 'notes.md')])
      expect(await readFile(join(directory, 'notes.md'), 'utf8')).toBe(desktopReleaseNotes({ changelog: CHANGELOG, version: '0.1.0' }))
      expect(() => execFileSync(process.execPath, [script, 'version', 'dsh-v0.2.1'], { stdio: 'pipe' })).toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('has a section for the first HalluCodex release in the repository changelog', async () => {
    const changelog = await readFile(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8')
    expect(desktopChangelogSection(changelog, '0.1.0')).not.toContain(DESKTOP_INSTALL_NOTES_MARKER)
  })
})
