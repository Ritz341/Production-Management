// Service worker for the tablet home-screen app.
//
// Only the app shell (HTML, JS, CSS, icons) is cached. Supabase traffic
// is never touched: order data must always be live, and a cached status
// on a shop tablet would be worse than no status at all.
const CACHE = 'build-tracker-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return

  // Pages: always try the network first so a new deploy shows up on the
  // next open; fall back to the cached shell when wifi is down.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(CACHE).then((c) => c.put('/', res.clone()))
          return res
        })
        .catch(() => caches.match('/'))
    )
    return
  }

  // Built assets have content hashes in their names, so a cached copy
  // is never stale — serve it, and cache anything new as it's fetched.
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()))
          return res
        })
    )
  )
})
