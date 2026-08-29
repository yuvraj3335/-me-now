import { actions } from './api'

const urlBase64ToUint8Array = (base64: string) => {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

/**
 * iOS only delivers Web Push to a PWA installed on the Home Screen; in a Safari
 * tab the API exists but permission can never be granted. Detecting that lets
 * the UI say so plainly instead of showing a toggle that silently does nothing.
 * See DECISIONS.md #13.
 */
export const isIos = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as any).standalone === true

export const needsHomeScreenInstall = () => isIos() && !isStandalone()

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch {
    return null
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) return { ok: false, reason: 'This browser has no Web Push support.' }
  if (needsHomeScreenInstall()) {
    return { ok: false, reason: 'On iPhone, add Wake to your Home Screen first — Safari tabs cannot receive push.' }
  }

  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerSW())
  if (!reg) return { ok: false, reason: 'Service worker failed to register.' }
  await navigator.serviceWorker.ready

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { ok: false, reason: 'Notification permission was declined.' }

  const { key } = await actions.pushKey()
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    }))

  await actions.pushSubscribe(sub.toJSON(), navigator.userAgent.slice(0, 80))
  return { ok: true }
}

export async function disablePush() {
  const sub = await currentSubscription()
  if (!sub) return
  await actions.pushUnsubscribe(sub.endpoint)
  await sub.unsubscribe()
}
