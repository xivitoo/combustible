const BASE_PATH = __BASE_PATH_SAFE__();
const CACHE_VERSION = __BUILD_VERSION_SAFE__();
const SHELL_CACHE = `combustible-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = 'combustible-runtime-v1';

function __BASE_PATH_SAFE__() {
  const raw = '__BASE_PATH__';
  if (raw.startsWith('__')) {
    return new URL('./', self.location.href).pathname;
  }
  return JSON.parse(raw);
}

function __BUILD_VERSION_SAFE__() {
  const raw = '__BUILD_VERSION__';
  if (raw.startsWith('__')) return 'dev';
  return JSON.parse(raw);
}

function getPrecacheUrls() {
  const raw = '__PRECACHE_URLS__';
  if (raw.startsWith('__')) {
    return [
      BASE_PATH,
      `${BASE_PATH}index.html`,
      `${BASE_PATH}manifest.webmanifest`,
      `${BASE_PATH}icon.svg`,
      `${BASE_PATH}pwa-192x192.png`,
      `${BASE_PATH}pwa-512x512.png`,
      `${BASE_PATH}apple-touch-icon.png`,
      `${BASE_PATH}assets/aistudio/combustible_54e5caba.jpg`,
    ];
  }
  return JSON.parse(raw);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(getPrecacheUrls()))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) =>
                (k.startsWith('combustible-shell-') && k !== SHELL_CACHE) ||
                k === 'combustible-tiles-v1'
            )
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Nunca interceptar consultas de precios Online, teselas CartoDB ni módulos de desarrollo Vite
  if (
    url.pathname.includes('/api/fuel/') ||
    url.pathname.includes('/@vite/') ||
    url.pathname.includes('/src/') ||
    url.pathname.includes('/node_modules/') ||
    url.hostname.includes('workers.dev') ||
    url.hostname.includes('minetur.gob.es') ||
    url.hostname.endsWith('basemaps.cartocdn.com')
  ) {
    return;
  }

  // Navegación HTML: Network-first con fallback al shell Offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached =
            (await caches.match(request)) ||
            (await caches.match(`${BASE_PATH}index.html`)) ||
            (await caches.match(BASE_PATH));
          return cached || Response.error();
        })
    );
    return;
  }

  // Predicción diaria: Network-first para mostrar siempre la previsión más reciente cuando haya conexión
  if (url.origin === self.location.origin && url.pathname.endsWith('/data/prediccion_actual.json')) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        try {
          const res = await fetch(request);
          if (res.ok) {
            cache.put(request, res.clone());
          }
          return res;
        } catch {
          const cached = await cache.match(request);
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Mismo origen y fuentes: Stale-While-Revalidate
  if (
    url.origin === self.location.origin ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  ) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached =
          (await caches.match(request)) || (await cache.match(request));
        const networkPromise = fetch(request)
          .then((res) => {
            if (res.ok) {
              cache.put(request, res.clone());
            }
            return res;
          })
          .catch(() => null);

        return cached || (await networkPromise) || Response.error();
      })
    );
  }
});
