/* Uses the existing compat Firebase app, Auth and Firestore instances. */
(() => {
  const button = document.getElementById("bpEnableNotifications");
  const status = document.getElementById("bpNotifyStatus");
  const config = globalThis.BudgetPushConfig;
  let activeUid = null, record, messaging, registration, unsubscribeMessage;
  let queue = Promise.resolve();
  const enqueue = task => (queue = queue.catch(() => {}).then(task));
  const validUser = uid => auth.currentUser?.uid === uid && auth.currentUser.emailVerified && activeUid === uid;
  const supported = async () => isSecureContext && "Notification" in window &&
    "serviceWorker" in navigator && "PushManager" in window && await firebase.messaging.isSupported();
  const readyConfig = () => config.enabled && config.vapidKey;

  async function prepare() {
    registration = await navigator.serviceWorker.register("./service-worker.js");
    const worker = registration.installing || registration.waiting;
    if (worker && worker.state !== "activated") await new Promise((resolve, reject) => {
      const check = () => {
        if (worker.state === "activated") { worker.removeEventListener("statechange", check); resolve(); }
        else if (worker.state === "redundant") { worker.removeEventListener("statechange", check); reject(new Error("Worker activation failed")); }
      };
      worker.addEventListener("statechange", check);
      check();
    });
    registration = await navigator.serviceWorker.ready;
    messaging ||= firebase.messaging();
    if (!unsubscribeMessage) unsubscribeMessage = messaging.onMessage(payload => {
      registration.active?.postMessage({ type: "BUDGET_PUSH", data: payload.data });
    });
  }
  async function register(uid) {
    await prepare();
    const token = await messaging.getToken({ vapidKey: config.vapidKey, serviceWorkerRegistration: registration });
    if (!token) throw new Error("No token");
    if (!validUser(uid)) return false;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const id = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
    const ref = db.collection("users").doc(uid).collection("budgetPushTokens").doc(id);
    // No polling writes: only initial enable, token changes, or a monthly refresh.
    const key = `bp-push-registration:${uid}:${id}`;
    let last = 0;
    try { last = Number(localStorage.getItem(key)) || 0; } catch {}
    if (Date.now() - last > 30 * 86400000) {
      await ref.set({ token, updatedAt: Date.now() });
      try { localStorage.setItem(key, String(Date.now())); } catch {}
    }
    if (!validUser(uid)) { await ref.delete().catch(() => {}); return false; }
    if (record && (record.uid !== uid || record.id !== id)) await record.ref.delete().catch(() => {});
    record = { uid, id, ref, key };
    await BudgetPushState.setOwner(uid);
    status.textContent = "Background reminders enabled for this device.";
    return true;
  }
  async function clear() {
    await BudgetPushState.setOwner(null);
    if (record) {
      try { localStorage.removeItem(record.key); } catch {}
      await record.ref.delete().catch(() => {});
    }
    record = null;
    if (messaging) await messaging.deleteToken().catch(() => {});
    if (registration) (await registration.getNotifications()).forEach(n => n.close());
  }
  window.BudgetPush = {
    detach() { activeUid = null; return enqueue(clear).catch(() => {}); }
  };
  auth.onAuthStateChanged(user => {
    activeUid = user?.emailVerified ? user.uid : null;
    const uid = activeUid;
    enqueue(async () => {
      await BudgetPushState.setOwner(null);
      if (record && record.uid !== uid) await clear();
      if (!uid || !validUser(uid)) return;
      if (!readyConfig()) {
        status.textContent = "Background reminders are awaiting setup.";
        return;
      }
      if (await supported() && Notification.permission === "granted") await register(uid);
    }).catch(() => { status.textContent = "Could not refresh notifications. Tap Enable notifications to try again."; });
  });
  // Email verification can finish without a new Auth event in the existing app.
  button.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user?.emailVerified) { status.textContent = "Sign in with a verified account first."; return; }
    activeUid = user.uid;
    if (!readyConfig()) { status.textContent = "Background reminders are awaiting setup."; return; }
    button.disabled = true;
    try {
      if (!isSecureContext || !("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        status.textContent = "Notifications are not supported here. On iPhone, add this app to your Home Screen and open it there."; return;
      }
      // Request permission in the button gesture, before token operations.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { status.textContent = "Notifications are off. You can allow them in this device’s app or browser settings."; return; }
      if (!await supported()) { status.textContent = "This browser does not support background notifications."; return; }
      await enqueue(async () => {
        if (!validUser(user.uid) || !await register(user.uid)) return;
        registration.active?.postMessage({ type: "BUDGET_PUSH", data: {
          kind: "enabled", uid: user.uid, deliveryId: "enabled-" + crypto.randomUUID(),
          title: "Budget Planner notifications enabled",
          body: "We’ll remind you to update your income dates each month and group manual payments due into one daily alert.",
          expiresAt: String(Date.now() + 300000)
        }});
      });
    } catch {
      status.textContent = "Could not enable background reminders. Check your connection and try again.";
    } finally { button.disabled = false; }
  });
  // Keep the existing app available offline even before push is configured.
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./service-worker.js").catch(() => {});
})();
