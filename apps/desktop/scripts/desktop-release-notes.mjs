/**
 * Derive a HalluCodex release from its tag and write its GitHub Release notes.
 *
 * The notes are the matching `CHANGELOG.md` section, then the install-notes marker, then
 * instructions for unsigned installers. The application's update dialog shows the notes and
 * cuts everything from the marker on, so the marker appears exactly once.
 * Usage: `node desktop-release-notes.mjs version <tag>` prints `version=` and `prerelease=` lines;
 * `node desktop-release-notes.mjs notes --version <version> --changelog <path> --output <path>` writes the notes.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Tag prefix of HalluCodex desktop releases; upstream `dsh-v*` tags are not releases of this application. */
export const DESKTOP_RELEASE_TAG_PREFIX = 'hallucodex-v'

/** Line separating the release notes the application shows from the installation instructions. */
export const DESKTOP_INSTALL_NOTES_MARKER = '<!-- hallucodex:install-notes -->'

// SemVer 2.0.0 without build metadata, which does not take part in update precedence.
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?$/u

const INSTALL_NOTES = `## 安装说明

当前安装包尚未使用付费证书签名。

- **macOS**：把 HalluCodex 拖入“应用程序”后，首次启动时在 Finder 中按住 Control 点按（或右键）HalluCodex 并选择“打开”；macOS 15 及以上若仍被拦截，前往“系统设置 → 隐私与安全性”点按“仍要打开”。也可以在终端执行 \`xattr -dr com.apple.quarantine /Applications/HalluCodex.app\`。
- **Windows**：若 SmartScreen 提示“Windows 已保护你的电脑”，点击“更多信息”，再点击“仍要运行”。
- **Linux**：AppImage 需先执行 \`chmod +x\` 再运行；deb 可用 \`sudo apt install ./<文件名>.deb\` 安装。
- 下载后可在 Linux 上用 \`sha256sum -c SHA256SUMS --ignore-missing\` 核对 \`SHA256SUMS\`。

### Installing unsigned builds

- **macOS**: Control-click (right-click) HalluCodex in Applications and choose Open. On macOS 15 or later, use System Settings → Privacy & Security → Open Anyway, or run \`xattr -dr com.apple.quarantine /Applications/HalluCodex.app\`.
- **Windows**: when SmartScreen appears, click More info, then Run anyway.
- **Linux**: run \`chmod +x\` on the AppImage before starting it, or install the deb with \`sudo apt install ./<file>.deb\`.
`

/**
 * Read the application version a release tag names.
 * @param {string} tag - Pushed or requested tag, such as `hallucodex-v0.1.0-beta.1`.
 * @returns {{ version: string, prerelease: boolean }} Version without the prefix, and whether it has a prerelease part.
 */
export function desktopReleaseVersion(tag) {
  if (!tag.startsWith(DESKTOP_RELEASE_TAG_PREFIX)) {
    throw new Error(`desktop release: tag ${tag} must start with ${DESKTOP_RELEASE_TAG_PREFIX}`)
  }
  const version = tag.slice(DESKTOP_RELEASE_TAG_PREFIX.length)
  if (!SEMVER.test(version)) throw new Error(`desktop release: ${version} from tag ${tag} is not a SemVer version without build metadata`)
  return { version, prerelease: version.includes('-') }
}

/**
 * Return the body of the one changelog section headed by a version.
 * Accepted headings are `## 0.1.0`, `## [0.1.0]`, and either form followed by ` - <date>`.
 * @param {string} changelog - Markdown text of `CHANGELOG.md`.
 * @param {string} version - Release version.
 * @returns {string} Section body without its heading, trimmed.
 */
export function desktopChangelogSection(changelog, version) {
  const heading = /^##\s+\[?([^\]\s]+)\]?(?:\s+-\s+.*)?\s*$/u
  const lines = changelog.replace(/\r\n/gu, '\n').split('\n')
  const starts = lines.flatMap((line, index) => heading.exec(line)?.[1] === version ? [index] : [])
  if (starts.length !== 1) {
    throw new Error(`desktop release: CHANGELOG.md must contain exactly one "## ${version}" section, found ${starts.length}`)
  }
  const start = starts[0] + 1
  const next = lines.findIndex((line, index) => index >= start && /^##\s/u.test(line))
  const body = lines.slice(start, next === -1 ? undefined : next).join('\n').trim()
  if (body === '') throw new Error(`desktop release: CHANGELOG.md section ${version} is empty`)
  return body
}

/**
 * Compose the GitHub Release body: changelog section, marker, and install instructions.
 * @param {{ changelog: string, version: string }} request - Changelog text and release version.
 * @returns {string} Markdown body ending with one newline.
 */
export function desktopReleaseNotes({ changelog, version }) {
  const section = desktopChangelogSection(changelog, version)
  if (section.includes(DESKTOP_INSTALL_NOTES_MARKER)) {
    throw new Error(`desktop release: CHANGELOG.md section ${version} must not contain ${DESKTOP_INSTALL_NOTES_MARKER}`)
  }
  return `${section}\n\n${DESKTOP_INSTALL_NOTES_MARKER}\n\n${INSTALL_NOTES}`
}

function main(argv) {
  const [command, ...rest] = argv
  if (command === 'version' && rest.length === 1) {
    const { version, prerelease } = desktopReleaseVersion(rest[0])
    process.stdout.write(`version=${version}\nprerelease=${String(prerelease)}\n`)
    return
  }
  if (command === 'notes') {
    const { values } = parseArgs({ args: rest, options: {
      version: { type: 'string' }, changelog: { type: 'string' }, output: { type: 'string' },
    } })
    if (!values.version || !values.changelog || !values.output) {
      throw new Error('desktop release: notes requires --version, --changelog, and --output')
    }
    const changelog = readFileSync(resolve(values.changelog), 'utf8')
    writeFileSync(resolve(values.output), desktopReleaseNotes({ changelog, version: values.version }))
    return
  }
  throw new Error('desktop release: expected "version <tag>" or "notes --version <version> --changelog <path> --output <path>"')
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) main(process.argv.slice(2))
