import { describe, expect, it, vi } from 'vitest'
import type { NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { defaultWorkspaceDirectory, validateDocumentsDirectory, validateProductDirectory } from '../src/default-directory.ts'

describe('system Documents directory', () => {
  it.each([
    ['darwin', '/Users/a/文档/\n', '/Users/a/文档/deepseek-harness/default-workspace', 'osascript'],
    ['win32', 'D:\\Redirected Documents\r\n', 'D:\\Redirected Documents\\deepseek-harness\\default-workspace', 'powershell.exe'],
    ['linux', '/home/a/My Documents\n', '/home/a/My Documents/deepseek-harness/default-workspace', 'xdg-user-dir'],
  ] as const)('uses the %s account directory and preserves spaces and Unicode', async (platform, stdout, path, command) => {
    const run = vi.fn<NativeCommandRunner>(async () => ({ stdout, stderr: '' }))
    const signal = new AbortController().signal
    await expect(defaultWorkspaceDirectory(undefined, signal, { platform, run })).resolves.toBe(path)
    expect(run).toHaveBeenCalledWith(command, expect.any(Array), signal, 'hidden')
  })

  it('uses the configured directory without a system lookup', async () => {
    const run = vi.fn<NativeCommandRunner>()
    await expect(defaultWorkspaceDirectory('/documents', new AbortController().signal, { platform: 'linux', run }))
      .resolves.toBe('/documents/deepseek-harness/default-workspace')
    expect(run).not.toHaveBeenCalled()
  })

  it('places the Workspace under a configured product folder', async () => {
    await expect(defaultWorkspaceDirectory('/documents', new AbortController().signal, { platform: 'linux' }, 'HalluCodex'))
      .resolves.toBe('/documents/HalluCodex/default-workspace')
    await expect(defaultWorkspaceDirectory('D:\\Docs', new AbortController().signal, { platform: 'win32' }, 'HalluCodex'))
      .resolves.toBe('D:\\Docs\\HalluCodex\\default-workspace')
  })

  it.each(['', '.', '..', 'a/b', 'a\\b'])('rejects a product folder that is not one path segment: %j', (name) => {
    expect(() => validateProductDirectory(name)).toThrow('one path segment')
  })

  it.each(['', '\r\n', '/home/a\n'])('rejects an unavailable XDG directory %j', async (stdout) => {
    const run: NativeCommandRunner = async () => ({ stdout, stderr: '' })
    await expect(defaultWorkspaceDirectory(undefined, new AbortController().signal, { platform: 'linux', home: '/home/a', run }))
      .rejects.toThrow('unavailable')
  })

  it('propagates lookup failure and cancellation', async () => {
    const run: NativeCommandRunner = async () => { throw new Error('lookup denied') }
    await expect(defaultWorkspaceDirectory(undefined, new AbortController().signal, { platform: 'darwin', run }))
      .rejects.toThrow('lookup denied')
    await expect(defaultWorkspaceDirectory('/documents', AbortSignal.abort(), { platform: 'linux' }))
      .rejects.toThrow()
    await expect(defaultWorkspaceDirectory(undefined, new AbortController().signal, { platform: 'freebsd' }))
      .rejects.toThrow('unavailable')
  })

  it.each(['relative', 'C:relative', '\\rooted'])('rejects a Windows path without a fully qualified root: %s', (path) => {
    expect(() => validateDocumentsDirectory(path, 'win32')).toThrow('fully qualified')
  })

  it('accepts redirected UNC Documents directories', () => {
    expect(validateDocumentsDirectory('\\\\server\\share\\Documents', 'win32')).toBe('\\\\server\\share\\Documents')
    expect(() => validateDocumentsDirectory('relative', 'linux')).toThrow('fully qualified')
  })
})
