/* eslint-disable @typescript-eslint/no-unsafe-call -- dbus-next proxy methods are typed as Function. */
import type dbus from 'dbus-next'

const STANDARD_NAME = 'org.freedesktop.secrets'
const KDE_COMPAT_NAME = 'org.kde.secretservicecompat'
const DBUS_NAME = 'org.freedesktop.DBus'

type Bus = ReturnType<typeof dbus.sessionBus>

/** KDE advertises its compatibility activation name, then claims the standard name. */
export async function ensureSecretService(bus: Bus): Promise<void> {
  const daemon = (await bus.getProxyObject(DBUS_NAME, '/org/freedesktop/DBus')).getInterface(
    DBUS_NAME
  )
  if ((await daemon.NameHasOwner!(STANDARD_NAME)) === true) return

  const activatable = (await daemon.ListActivatableNames!()) as unknown
  if (!Array.isArray(activatable) || !activatable.includes(KDE_COMPAT_NAME))
    throw new Error('Secret Service is unavailable')

  await daemon.StartServiceByName!(KDE_COMPAT_NAME, 0)
  const [standardOwner, compatOwner] = await Promise.all([
    daemon.GetNameOwner!(STANDARD_NAME),
    daemon.GetNameOwner!(KDE_COMPAT_NAME)
  ])
  if (!standardOwner || standardOwner !== compatOwner)
    throw new Error('KDE Secret Service did not acquire the standard bus name')
}
