import { describe, expect, it } from 'vitest'
import { desktopUpdateDelivery } from '../src/update-platform.ts'

describe('desktop update delivery', () => {
  it('installs in-app only where the platform updater can replace this build', () => {
    expect(desktopUpdateDelivery('win32', {})).toBe('install')
    expect(desktopUpdateDelivery('linux', { APPIMAGE: '/home/a/HalluCodex.AppImage' })).toBe('install')
    expect(desktopUpdateDelivery('linux', {})).toBe('download-page')
    expect(desktopUpdateDelivery('linux', { APPIMAGE: '' })).toBe('download-page')
    // Squirrel validates a Developer ID signature; only a signed build carries the packaged marker.
    expect(desktopUpdateDelivery('darwin', {})).toBe('download-page')
    expect(desktopUpdateDelivery('darwin', {}, 'install')).toBe('install')
    expect(desktopUpdateDelivery('darwin', {}, true)).toBe('download-page')
  })
})
