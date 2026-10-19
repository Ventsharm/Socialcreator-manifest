const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { IDBFactory } = require('fake-indexeddb');
function worker(indexedDB = new IDBFactory()) {
  const listeners = {}, notices = [], deleted = [], windows = [], opened = [];
  let background, online = true;
  const responses = new Map();
  const cache = {
    addAll: async urls => urls.forEach(u => responses.set(u,{url:u,cached:true})),
    put: async (r,v) => responses.set(r.url || r,v),
    match: async r => responses.get(r.url || r),
  };
  const ctx = vm.createContext({
    indexedDB, URL, Intl, Date, console,
    caches: { open: async () => cache, keys: async () => ['socialcreator-budget-cache-v1','another-app'], delete: async k => deleted.push(k) },
    fetch: async request => { if (!online) throw new Error('offline'); return {ok:true,url:request.url,clone(){return this}}; },
    firebase: { initializeApp() {}, messaging: () => ({onBackgroundMessage: fn => {background=fn}}) },
    self: {
      skipWaiting() {},
      registration: {scope:'https://example.test/Socialcreator-manifest/',showNotification:async (title,options) => notices.push({title,...options})},
      addEventListener: (type,fn) => {listeners[type]=fn},
      clients: {claim:async()=>{},matchAll:async()=>windows,openWindow:async url=>opened.push(url)},
    },
    importScripts: (...urls) => { if (urls[0]==='./push-state.js') vm.runInContext(fs.readFileSync('push-state.js','utf8'),ctx); },
  });
  vm.runInContext(fs.readFileSync('service-worker.js','utf8'),ctx);
  const now = Date.now();
  const day = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/London'}).format(now);
  const payload = {data:{uid:'alice',deliveryId:'abc',kind:'daily',notifyDay:day,expiresAt:String(now+60000),title:'Tomorrow',body:'O2 due tomorrow'}};
  return {ctx,indexedDB,listeners,notices,deleted,windows,opened,payload,background:p=>background(p),offline:()=>{online=false}};
}
test('duplicate pushes display once, including after service-worker restart', async () => {
  const a=worker(); await a.ctx.BudgetPushState.setOwner('alice');
  await Promise.all([a.background(a.payload),a.background(a.payload)]);
  assert.equal(a.notices.length,1);
  const b=worker(a.indexedDB); await b.background(a.payload);
  assert.equal(b.notices.length,0);
  assert.equal(a.notices[0].data.url,'https://example.test/Socialcreator-manifest/?vs_app=vs1_b683200ce1ae276c95a1e6fa#expenses');
});
test('expired, due-date, wrong-user and signed-out pushes are suppressed', async () => {
  const w=worker(); await w.ctx.BudgetPushState.setOwner('alice');
  for(const change of [{uid:'bob'},{notifyDay:'2000-01-01'},{expiresAt:'1'},{expiresAt:'oops'}]) {
    await w.background({data:{...w.payload.data,...change}});
  }
  await w.ctx.BudgetPushState.setOwner(null); await w.background(w.payload);
  assert.equal(w.notices.length,0);
});
test('enable confirmation is separate from daily alert and shares deduplication', async () => {
  const w=worker(); await w.ctx.BudgetPushState.setOwner('alice');
  const p={data:{...w.payload.data,kind:'enabled',deliveryId:'enabled-alice',notifyDay:undefined}};
  await w.background(p); await w.background(p); await w.background(w.payload);
  assert.equal(w.notices.length,2);
});
test('offline shell survives upgrade; unrelated caches and API requests are left alone', async () => {
  const w=worker(); let pending;
  w.listeners.install({waitUntil:p=>{pending=p}}); await pending;
  w.listeners.activate({waitUntil:p=>{pending=p}}); await pending;
  assert.deepEqual(w.deleted,['socialcreator-budget-cache-v1']);
  w.offline();
  const request={method:'GET',mode:'navigate',url:'https://example.test/Socialcreator-manifest/?from=notification'};
  w.listeners.fetch({request,respondWith:p=>{pending=p}});
  assert.equal((await pending).cached,true);
  let intercepted=false;
  w.listeners.fetch({request:{method:'GET',url:'https://firestore.googleapis.com/x'},respondWith:()=>{intercepted=true}});
  assert.equal(intercepted,false);
});
test('notification links reuse an app window or open the reminders page', async () => {
  const w=worker(); let pending, navigated, focused=false;
  const notification={tag:'budget-abc',close(){}};
  w.windows.push({url:'https://example.test/Socialcreator-manifest/',navigate:async u=>{navigated=u},focus:async()=>{focused=true}});
  w.listeners.notificationclick({notification,waitUntil:p=>{pending=p}}); await pending;
  assert.equal(navigated,'https://example.test/Socialcreator-manifest/?vs_app=vs1_b683200ce1ae276c95a1e6fa#expenses'); assert.equal(focused,true);
  w.windows.length=0;
  w.listeners.notificationclick({notification,waitUntil:p=>{pending=p}}); await pending;
  assert.deepEqual(w.opened,['https://example.test/Socialcreator-manifest/?vs_app=vs1_b683200ce1ae276c95a1e6fa#expenses']);
});
