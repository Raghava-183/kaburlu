// Kaburlu service worker: lets the app install on phones, open quickly,
// and show notifications when the app is closed.

/* ---------- Notifications ---------- */
// Tapping a notification opens the app on that chat.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const chatId = e.notification.data?.chatId || "";
  const url = chatId ? `/?chat=${encodeURIComponent(chatId)}` : "/";
  e.waitUntil((async () => {
    const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).origin === location.origin && "focus" in c) {
        c.postMessage({ type: "open-chat", chatId });
        return c.focus();
      }
    }
    return clients.openWindow(url);
  })());
});

importScripts(
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js"
);
// Same values as public/firebase-config.js (a service worker can't import that file).
firebase.initializeApp({
  apiKey: "AIzaSyAx_svFr4RQpGMmW98auPCHVvRq2kPqCs0",
  authDomain: "kaburlu-9c280.firebaseapp.com",
  projectId: "kaburlu-9c280",
  messagingSenderId: "698139980991",
  appId: "1:698139980991:web:0de843009ece3ed499020a"
});
firebase.messaging().onBackgroundMessage((p) => {
  const d = p.data || {};
  return self.registration.showNotification(d.title || "Kaburlu", {
    body: d.body || "New message",
    icon: "/icons/icon-192.png",
    tag: d.chatId || "kaburlu",
    renotify: true,
    data: { chatId: d.chatId || "" }
  });
});

/* ---------- Offline + fast start ---------- */
// Pages and scripts are fetched fresh when online (so updates show right away)
// and served from cache when offline.
const CACHE = "kaburlu-v2";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/firebase-config.js",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only handle our own files. Never touch the server API or Firebase traffic.
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("/index.html")))
  );
});
