const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ukDay, nextMidnight, dueToday, content, runDaily } = require('../automation/reminders.cjs');
function fixture(items = [], date = '2026-10-17T08:30:00Z') {
  const now = Date.parse(date), claims = new Map(), sent = [], reads = [];
  let writes = 0, throwSend = false;
  const devices = ['alice', 'bob'].map(uid => ({
    ref: { path: `users/${uid}/budgetPushTokens/hash`, delete: async () => {} },
    data: () => ({ token: uid + '-token-'.repeat(5) })
  }));
  const claimRef = path => ({ path, get: async () => { reads.push(path); return { exists: claims.has(path) }; } });
  const db = {
    collectionGroup: name => {
      assert.equal(name, 'budgetPushTokens');
      const q = { orderBy: () => q, limit: () => q, get: async () => ({ docs: devices, size: devices.length, empty: !devices.length }) };
      return q;
    },
    collection: name => ({ doc: uid => ({ collection: type => ({ get: async () => {
      assert.equal(name, 'users'); assert.equal(type, 'expenses'); reads.push(`${uid}/expenses`);
      return { docs: items.filter(e => !e.uid || e.uid === uid).map(e => ({ data: () => e })) };
    } }) }) }),
    doc: claimRef,
    runTransaction: async fn => fn({
      get: async ref => ref.get(),
      create: (ref, value) => { claims.set(ref.path, value); writes++; },
      delete: () => { writes++; }
    })
  };
  const messaging = { sendEachForMulticast: async payload => {
    sent.push(payload); if (throwSend) throw new Error('network');
    return { responses: payload.tokens.map(() => ({ success: true })) };
  } };
  return { db, messaging, now, clock: () => now, claims, sent, reads, devices,
    get writes() { return writes; }, failSend() { throwSend = true; } };
}
const manual = (title, extra = {}) => ({ title, date: '2025-11-17', method: 'manual', paid: false, monthBucket: 'this', amount: 12, ...extra });
test('UK day and expiry cover BST, New Year, and both clock changes', () => {
  assert.equal(ukDay(Date.parse('2026-09-30T23:00:00Z')), '2026-10-01');
  for (const stamp of ['2026-03-28T12:00:00Z', '2026-03-29T12:00:00Z', '2026-10-24T12:00:00Z', '2026-10-25T12:00:00Z', '2026-12-31T12:00:00Z']) {
    const now = Date.parse(stamp), expiry = nextMidnight(now);
    assert.equal(ukDay(expiry - 1), ukDay(now));
    assert.notEqual(ukDay(expiry), ukDay(now));
  }
});
test('only unpaid current-month manual payments are due; legacy defaults and short months work', () => {
  assert(dueToday(manual('a'), '2026-10-17'));
  for (const patch of [{ method: 'automatic' }, { paid: true }, { monthBucket: 'next' }, { date: '' }, { date: '2025-13-17' }]) {
    assert(!dueToday(manual('a', patch), '2026-10-17'));
  }
  assert(dueToday(manual('legacy', { method: undefined, monthBucket: undefined }), '2026-10-17'));
  assert(dueToday(manual('end', { date: '2025-01-31' }), '2027-02-28'));
  assert(dueToday(manual('end', { date: '2025-01-31' }), '2028-02-29'));
  assert(!dueToday(manual('end', { date: '2025-01-31' }), '2028-02-28'));
});
test('multiple due payments produce one alert per account; accounts are isolated', async () => {
  const f = fixture([manual('Water', { uid: 'alice' }), manual('Rent', { uid: 'alice' }), manual('Phone', { uid: 'bob' }), manual('Automatic', { method: 'automatic' }), manual('Paid', { paid: true })]);
  const stats = await runDaily(f);
  assert.equal(stats.sent, 2); assert.equal(f.writes, 2); assert.equal(f.sent.length, 2);
  assert.match(f.sent[0].data.body, /Water/); assert.match(f.sent[0].data.body, /Rent/);
  assert.doesNotMatch(f.sent[0].data.body, /Phone|Automatic|Paid/);
  assert.match(f.sent[1].data.body, /Phone/); assert.doesNotMatch(f.sent[1].data.body, /Water/);
  assert(!('notification' in f.sent[0]));
});
test('first-of-month income prompt and all payments share a single notification', async () => {
  const f = fixture([manual('Rent', { uid: 'alice', date: '2025-11-01' })], '2026-09-30T23:01:00Z');
  await runDaily(f);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0].data.body, /update when your incomes are due/);
  assert.match(f.sent[0].data.body, /Rent/);
  assert.match(f.sent[1].data.body, /update when your incomes are due/);
  assert.doesNotMatch(f.sent[1].data.body, /Manual payments/);
});
test('duplicate runs skip sends, writes and repeat expense reads', async () => {
  const f = fixture([manual('Rent')]); await runDaily(f);
  const reads = f.reads.filter(p => p.endsWith('/expenses')).length;
  const stats = await runDaily(f);
  assert.equal(stats.duplicates, 2); assert.equal(f.sent.length, 2); assert.equal(f.writes, 2);
  assert.equal(f.reads.filter(p => p.endsWith('/expenses')).length, reads);
});
test('dry run, expired run, no due payments and no opted-in devices never send or write', async () => {
  for (const mode of ['dry', 'expired', 'none', 'no-devices']) {
    const f = fixture(mode === 'none' ? [] : [manual('Rent')]);
    if (mode === 'no-devices') f.devices.length = 0;
    await runDaily({ ...f, dryRun: mode === 'dry', scheduledAt: mode === 'expired' ? f.now - 86400000 : f.now });
    assert.equal(f.sent.length, 0); assert.equal(f.writes, 0);
    if (mode === 'no-devices' || mode === 'expired') assert.equal(f.reads.length, 0);
  }
});
test('ambiguous FCM failures retain claims and never create repeated daily alerts', async () => {
  const f = fixture([manual('Rent')]); f.failSend();
  const result = await runDaily(f); assert.equal(result.failed, 2);
  await runDaily(f); assert.equal(f.sent.length, 2); assert.equal(f.writes, 2);
});
test('large Unicode lists stay inside the FCM limit with one explicit overflow summary', () => {
  const notice = content(Array.from({ length: 200 }, () => manual('🧾'.repeat(60))), '2026-10-17');
  assert(Buffer.byteLength(notice.body) < 3000); assert.match(notice.body, /more — open Budget Planner/);
});
