// Tau Service Worker — minimal, just enables PWA install
// No aggressive caching since Tau connects to a live local server
/// <reference lib="webworker" />

const CACHE_NAME = 'tau-fork-v29';
const serviceWorker = self as unknown as ServiceWorkerGlobalScope;

// Cache only the app shell on install
serviceWorker.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/styles/base.css',
        '/styles/main.css',
        '/styles/messages.css',
        '/styles/input.css',
        '/styles/overlays.css',
        '/styles/responsive.css',
        '/styles/sidebar.css',
        '/app.js',
        '/app-main.js',
        '/app-state.js',
        '/agent-sidebar.js',
        '/assistant-blocks.js',
        '/command-palette.js',
        '/compact-command.js',
        '/compaction-row.js',
        '/composer.js',
        '/dialogs.js',
        '/history-render.js',
        '/image-source.js',
        '/keyboard.js',
        '/live-views.js',
        '/markdown.js',
        '/message-renderer.js',
        '/javascript-code-block.js',
        '/nested-tool-calls.js',
        '/completion-list.js',
        '/model-match.js',
        '/model-picker.js',
        '/rpc-events.js',
        '/session-limit.js',
        '/agent-link.js',
        '/session-history.js',
        '/session-stats-card.js',
        '/session-view.js',
        '/header-menu.js',
        '/settings-panel.js',
        '/space-groups.js',
        '/state.js',
        '/themes.js',
        '/tool-card.js',
        '/tree-view.js',
        '/unsent-input.js',
        '/voice-input.js',
        '/websocket-client.js',
        '/manifest.json',
        '/icons/tau-192.png',
        '/icons/tau-512.png',
        '/icons/tau-maskable-512.png',
        // KaTeX shell assets; fonts are picked up on demand by the
        // network-first runtime cache so a missing font can't fail install.
        '/vendor/katex/katex.min.js',
        '/vendor/katex/katex.min.css',
        '/vendor/highlight/core.min.js',
        '/vendor/highlight/javascript.min.js',
        '/vendor/highlight/bash.min.js',
      ]);
    })
  );
  serviceWorker.skipWaiting();
});

// Clean old caches
serviceWorker.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      );
    })
  );
  serviceWorker.clients.claim();
});

// Network-first strategy — always try live server, fall back to cache
serviceWorker.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Leave credential submissions and their redirect to the browser.
  if (event.request.method !== 'GET' || url.pathname === '/login'
      || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Update cache with fresh response
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Offline — serve from cache
        return caches.match(event.request).then((cached) => {
          return cached || new Response('Tau is offline — start your pi session to connect.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          });
        });
      })
  );
});
