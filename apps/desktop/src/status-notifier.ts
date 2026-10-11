/** Linux session check for a panel that displays StatusNotifierItem tray icons. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const WATCHER = 'org.kde.StatusNotifierWatcher'

/** A command-line D-Bus client, its two session-bus queries, and how it prints boolean true. */
interface BusClient {
  readonly command: string
  readonly watcherOwned: readonly string[]
  readonly hostRegistered: readonly string[]
  readonly isTrue: RegExp
}

const CLIENTS: readonly BusClient[] = [
  {
    command: 'gdbus',
    watcherOwned: ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', WATCHER],
    hostRegistered: ['call', '--session', '--dest', WATCHER, '--object-path', '/StatusNotifierWatcher',
      '--method', 'org.freedesktop.DBus.Properties.Get', WATCHER, 'IsStatusNotifierHostRegistered'],
    isTrue: /^\(<?true>?,\)$/u,
  },
  {
    command: 'busctl',
    watcherOwned: ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
      'NameHasOwner', 's', WATCHER],
    hostRegistered: ['--user', 'get-property', WATCHER, '/StatusNotifierWatcher', WATCHER, 'IsStatusNotifierHostRegistered'],
    isTrue: /^b true$/u,
  },
]

async function ask(client: BusClient, args: readonly string[]): Promise<boolean> {
  const { stdout } = await promisify(execFile)(client.command, [...args], { timeout: 2000, encoding: 'utf8' })
  return client.isTrue.test(stdout.trim())
}

/**
 * Report whether the session bus has a StatusNotifier host, by the two checks Electron makes when it creates a Linux
 * tray icon: the watcher name has an owner and the watcher reports a registered host. Electron otherwise falls back
 * to a GTK status icon that GNOME and Wayland sessions never display, and it does not report that fallback. The first
 * of `gdbus` and `busctl` that answers decides; when neither can query the bus, the result is false.
 * @returns Whether a tray icon created now is displayed.
 */
export async function statusNotifierHostRegistered(): Promise<boolean> {
  const failures: unknown[] = []
  for (const client of CLIENTS) {
    let owned: boolean
    try { owned = await ask(client, client.watcherOwned) } catch (error) { failures.push(error); continue }
    if (!owned) return false
    return await ask(client, client.hostRegistered).catch((error: unknown) => {
      console.warn('desktop tray: StatusNotifier host query failed', error)
      return false
    })
  }
  console.warn('desktop tray: no D-Bus client could query the session bus', failures)
  return false
}
