/* Budget Planner offline shell and FCM share the same registration. */
importScripts("./push-state.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.1/firebase-messaging-compat.js");
const CACHE_NAME = "socialcreator-budget-cache-v4-notifications";
const base = self.registration.scope;
const shell = ["./", "index.html", "manifest.webmanifest", "Icon-192.png", "Icon-512.png",
  "push-client.js", "push-config.js", "push-state.js"].map(p => new URL(p, base).href);
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(shell)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("socialcreator-budget-cache-") && k !== CACHE_NAME).map(k => caches.delete(k)))),
    self.clients.claim(),
  ]));
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== new URL(base).origin || !url.href.startsWith(base)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(event.request);
      if (response.ok && (event.request.mode === "navigate" || shell.includes(url.href))) {
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      if (event.request.mode === "navigate") {
        const home = await cache.match(new URL("./", base).href);
        if (home) return home;
      }
      throw error;
    }
  })());
});
firebase.initializeApp({
  apiKey:"AIzaSyCdqBDusmELyZ6S6OeiUX_I_POjydy-dN4",
  authDomain:"budget-app-283de.firebaseapp.com",
  projectId:"budget-app-283de",
  messagingSenderId:"162369707369",
  appId:"1:162369707369:web:3faa7f002f8ba22dc0f1f8"
});
function ukDay() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(Date.now()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
async function displayReminder(data) {
  if (!data?.deliveryId || !data.uid || !Number.isFinite(Number(data.expiresAt)) || Number(data.expiresAt) <= Date.now()) return;
  if (!["enabled", "daily"].includes(data.kind)) return;
  if (data.kind !== "enabled" && data.notifyDay !== ukDay()) return;
  if (!await BudgetPushState.claim(data.uid, data.deliveryId, ukDay())) return;
  await self.registration.showNotification(data.title || "Budget Planner reminder", {
    body: data.body, icon: new URL("Icon-192.png", base).href,
    tag: "budget-" + data.deliveryId, renotify: false,
    data: { url: new URL("./?vs_app=vs1_b683200ce1ae276c95a1e6fa#expenses", base).href },
  });
}
// Data-only payloads prevent Firebase from auto-displaying a second notification.
firebase.messaging().onBackgroundMessage(payload => displayReminder(payload.data));
self.addEventListener("message", event => {
  if (event.data?.type === "BUDGET_PUSH" && event.source?.url?.startsWith(base)) {
    event.waitUntil(displayReminder(event.data.data));
  }
});
self.addEventListener("notificationclick", event => {
  if (!event.notification.tag.startsWith("budget-")) return;
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL("./?vs_app=vs1_b683200ce1ae276c95a1e6fa#expenses", base).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => client.url.startsWith(base));
    if (existing) { await existing.navigate(url); return existing.focus(); }
    return self.clients.openWindow(url);
  })());
});
