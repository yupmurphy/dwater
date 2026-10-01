/* dwater service worker: offline shell + the push handler iOS requires. */

const CACHE = "dwater-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE).map((n) => caches.delete(n)),
      ))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate for our own files: instant start, and a republished
// config.js or app.js is picked up on the next open.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });

    const network = fetch(request)
      .then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(network);
      return cached;
    }

    const fresh = await network;
    if (fresh) return fresh;
    // A navigation that is offline and uncached still gets the shell.
    return (await cache.match("./index.html")) ??
      new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  })());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "dwater", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Timpul pentru apa 💧";
  const options = {
    body: data.body || "Bea un pahar de apa",
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    // A fresh tag per reminder, so each repeat alerts instead of silently
    // replacing the previous one.
    tag: `water-${data.reminder ?? 0}-${data.at ?? Date.now()}`,
    data: { url: "./" },
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);

    if ("setAppBadge" in navigator && typeof data.reminder === "number") {
      try {
        await navigator.setAppBadge(1);
      } catch { /* badges are a nicety */ }
    }

    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of clients) {
      client.postMessage({ type: "water-push", data });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil((async () => {
    // Close the whole pile of reminders, not just the one she tapped.
    const shown = await self.registration.getNotifications();
    shown.forEach((n) => n.close());

    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const client of clients) {
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow(event.notification.data?.url || "./");
  })());
});
