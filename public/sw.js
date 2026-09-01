/*
 * Wake's service worker.
 *
 * Two jobs: receive Web Push, and keep the app shell openable when the network
 * is flaky. It deliberately does NOT cache /api — stale cards are worse than no
 * cards on a page whose entire purpose is telling you what is true right now.
 */

const SHELL = 'wake-shell-v3'

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(['/', '/icons/icon-192.png', '/manifest.webmanifest']))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // Never serve a cached API response — see the note at the top.
  if (url.pathname.startsWith('/api/')) return

  // Navigations: network first, cached shell as the fallback, so a dropped
  // connection shows the app rather than the browser's error page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone()
          caches.open(SHELL).then(c => c.put('/', copy)).catch(() => {})
          return res
        })
        .catch(() => caches.match('/').then(r => r ?? Response.error())),
    )
    return
  }

  // Hashed assets are immutable: cache first is safe and makes reopens instant.
  //
  // Only a *successful* response is stored, and that is not a detail. The server
  // used to answer an unknown `/assets/` path with the SPA shell — 200, and
  // `text/html` — so a phone on a shell from before a deploy asked for a chunk
  // that no longer exists, got HTML, and cached it under a `.js` key. Every
  // later load then failed from cache, with no network involved, for as long as
  // the cache lived. The server 404s that path now; this is the half that stops
  // a bad answer outliving the deploy that caused it.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then(hit =>
        hit ?? fetch(request).then(res => {
          if (res.ok && !(res.headers.get('content-type') || '').includes('text/html')) {
            const copy = res.clone()
            caches.open(SHELL).then(c => c.put(request, copy)).catch(() => {})
          }
          return res
        }),
      ),
    )
  }
})

self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { title: 'Wake' } }

  // The title may lead with one emoji — the server puts exactly one there per
  // notification kind, because this is the only surface Wake draws on where no
  // glyph and no colour token of its own reaches. The body never carries one:
  // it is his own words, quoted back.
  const title = data.title || 'Wake'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Tagging by the server's dedup key means a repeat of the same thing
      // replaces its notification instead of stacking a second one.
      tag: data.tag || data.kind || 'wake',
      renotify: false,
      data: { url: data.url || '/' },
      vibrate: [18, 40, 18],
    }),
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = event.notification.data?.url || '/'

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const origin = self.location.origin

    // Reuse an open Wake window when there is one; opening a second copy of a
    // personal dashboard is never what you wanted.
    for (const client of all) {
      if (client.url.startsWith(origin)) {
        await client.focus()
        if (target.startsWith(origin) || target.startsWith('/')) {
          const path = target.startsWith('/') ? target : new URL(target).pathname
          client.postMessage({ type: 'navigate', path })
        } else {
          await self.clients.openWindow(target)
        }
        return
      }
    }
    await self.clients.openWindow(target)
  })())
})
