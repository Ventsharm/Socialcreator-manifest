const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
function client({ enabled = true, permission = 'default', failWrite = false } = {}) {
  const listeners = {}, notices = [], writes = [], deleted = [], owners = [], storage = new Map();
  const button = {}, status = {}, user = { uid: 'alice', emailVerified: true };
  let authCallback, tokenDeletes = 0, permissionRequests = 0, onOwner;
  button.addEventListener = (name, fn) => listeners[name] = fn;
  const registration = { active: { postMessage: data => notices.push(data) }, getNotifications: async () => [] };
  const notification = { permission, requestPermission: async () => { permissionRequests++; notification.permission = permission === 'denied' ? 'denied' : 'granted'; return notification.permission; } };
  const auth = { currentUser: user, onAuthStateChanged: fn => { authCallback = fn; } };
  const db = { collection: () => ({ doc: uid => ({ collection: () => ({ doc: id => ({
    set: async data => { if (failWrite) throw new Error('denied'); writes.push({ uid, id, ...data }); },
    delete: async () => deleted.push({ uid, id })
  }) }) }) }) };
  const messaging = () => ({ getToken: async () => 'long-notification-device-token', deleteToken: async () => { tokenDeletes++; }, onMessage: () => () => {} });
  messaging.isSupported = async () => true;
  const context = vm.createContext({
    document: { getElementById: id => id === 'bpEnableNotifications' ? button : status },
    auth, db, firebase: { messaging }, crypto: webcrypto, TextEncoder, isSecureContext: true,
    BudgetPushConfig: { enabled, vapidKey: 'public-test-key' },
    BudgetPushState: { setOwner: async uid => { owners.push(uid); onOwner?.(uid); } },
    navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) } },
    Notification: notification, PushManager: function () {},
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  });
  context.window = context;
  vm.runInContext(fs.readFileSync('push-client.js', 'utf8'), context);
  return { context, auth, button, status, notices, writes, deleted, owners, user,
    authChanged: value => { auth.currentUser = value; authCallback(value); },
    waitForOwner: uid => new Promise(resolve => { if(owners.at(-1)===uid)resolve(); else onOwner=value=>{if(value===uid)resolve();}; }),
    enable: () => listeners.click(),
    get permissionRequests() { return permissionRequests; }, get tokenDeletes() { return tokenDeletes; }
  };
}
test('enable registers device and displays one confirmation; second enable avoids a repeat token write', async () => {
  const c = client(); await c.enable();
  assert.equal(c.writes.length, 1); assert.equal(c.notices.length, 1);
  assert.equal(c.notices[0].data.kind, 'enabled'); assert.equal(c.notices[0].data.uid, 'alice');
  assert.match(c.status.textContent, /Background reminders enabled/);
  await c.enable(); assert.equal(c.writes.length, 1);
  assert.equal(c.button.disabled, false);
});
test('denied permission and incomplete setup do not register or claim reminders are enabled', async () => {
  for (const options of [{ permission: 'denied' }, { enabled: false }, { failWrite: true }]) {
    const c = client(options); await c.enable();
    assert.equal(c.writes.length, 0); assert.equal(c.notices.length, 0);
    assert.doesNotMatch(c.status.textContent, /^Background reminders enabled/);
  }
});
test('logout removes device token and local account ownership before returning', async () => {
  const c = client(); await c.enable(); await c.context.BudgetPush.detach();
  assert.equal(c.deleted.length, 1); assert.equal(c.tokenDeletes, 1);
  assert.equal(c.owners.at(-1), null);
});
test('account switching suppresses previous owner and registers the new account separately', { timeout: 1000 }, async () => {
  const c = client(); await c.enable();
  c.authChanged({ uid: 'bob', emailVerified: true });
  await c.waitForOwner('bob');
  assert.equal(c.deleted[0].uid, 'alice');
  assert.equal(c.writes.at(-1).uid, 'bob'); assert.equal(c.owners.at(-1), 'bob');
});
test('signed-out and unverified users cannot enable notifications', async () => {
  for (const user of [null, { uid: 'alice', emailVerified: false }]) {
    const c = client(); c.authChanged(user); await c.enable();
    assert.equal(c.writes.length, 0); assert.equal(c.notices.length, 0); assert.equal(c.permissionRequests, 0);
  }
});
test('all inline and external app JavaScript parses and notification button is below the tabs', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
  for (const path of ['push-client.js', 'push-config.js', 'push-state.js', 'service-worker.js']) new vm.Script(fs.readFileSync(path, 'utf8'));
  assert(html.indexOf('id="bpEnableNotifications"') > html.indexOf('id="tab-ovw"'));
  assert(html.indexOf('id="bpEnableNotifications"') < html.indexOf('id="view-incomes"'));
});
