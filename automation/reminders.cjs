const { createHash } = require('node:crypto');
const PAGE_SIZE = 100;
const MAX_DEVICES_PER_USER = 500;
function ukDay(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).map(p => [p.type, p.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function nextMidnight(now) {
  const d = new Date(ukDay(now) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  const next = d.toISOString().slice(0, 10);
  const utc = Date.parse(next + 'T00:00:00Z');
  return ukDay(utc - 3600000) === next ? utc - 3600000 : utc;
}
function dueToday(expense, today) {
  if ((expense.method || 'manual') !== 'manual' || expense.paid ||
      (expense.monthBucket || 'this') !== 'this') return false;
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(expense.date || '');
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12) return false;
  const day = Number(match[2]);
  if (day < 1 || day > 31) return false;
  // Expenses are monthly day-of-month items in the existing app. A short month
  // uses its last day; no original dates or paid/month-bucket fields are changed.
  const [year, month, date] = today.split('-').map(Number);
  return Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate()) === date;
}
function cleanTitle(value) {
  return String(value || 'Manual payment').replace(/[\r\n\t]+/g, ' ').trim() || 'Manual payment';
}
function content(expenses, today) {
  const monthly = today.endsWith('-01');
  if (!monthly && !expenses.length) return null;
  const prefix = monthly ? 'New month: update when your incomes are due.' : '';
  const lines = expenses.map(e => cleanTitle(e.title) +
    (typeof e.amount === 'number' && Number.isFinite(e.amount) ? ` · £${e.amount.toFixed(2)}` : ''));
  const heading = lines.length ? `Manual payments due today (${lines.length}):` : '';
  // FCM has a payload limit. Keep one notification, with an explicit overflow
  // count for unusually large lists rather than sending several alerts.
  const parts = [prefix, heading].filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (Buffer.byteLength([...parts, lines[i]].join('\n'), 'utf8') > 2700) {
      parts.push(`+${lines.length - i} more — open Budget Planner for the full list.`);
      break;
    }
    parts.push(lines[i]);
  }
  return { title: 'Budget Planner reminder', body: parts.join('\n') };
}
function deliveryId(uid, today) {
  return createHash('sha256').update(`budget-daily|${uid}|${today}`).digest('hex');
}
async function* tokenPages(db) {
  let cursor;
  while (true) {
    let query = db.collectionGroup('budgetPushTokens').orderBy('__name__').limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) return;
    yield page.docs;
    if (page.size < PAGE_SIZE) return;
    cursor = page.docs.at(-1);
  }
}
async function runDaily({ db, messaging, now = Date.now(), scheduledAt = now, clock = Date.now, dryRun = false }) {
  const today = ukDay(now), expiresAt = nextMidnight(now);
  const stats = { devices: 0, users: 0, duePayments: 0, claimed: 0, duplicates: 0, sent: 0, failed: 0, invalidTokens: 0 };
  if (ukDay(scheduledAt) !== today) return { ...stats, skipped: 'expired schedule' };
  // Only accounts with opted-in devices are queried. No income reads, new
  // recurring records, polling, or per-expense notification writes are needed.
  const users = new Map();
  for await (const page of tokenPages(db)) for (const doc of page) {
    const path = doc.ref.path.split('/'), data = doc.data();
    if (path.length !== 4 || path[0] !== 'users' || path[2] !== 'budgetPushTokens' ||
        typeof data.token !== 'string' || data.token.length < 20) continue;
    const uid = path[1];
    if (!users.has(uid)) users.set(uid, []);
    const devices = users.get(uid);
    if (devices.length >= MAX_DEVICES_PER_USER) throw new Error('Device safety limit exceeded');
    devices.push(doc); stats.devices++;
  }
  for (const [uid, devices] of users) {
    if (clock() >= expiresAt) return { ...stats, skipped: 'UK day ended' };
    stats.users++;
    const id = deliveryId(uid, today);
    const claimRef = db.doc(`budgetReminderDeliveries/${id}`);
    // Fast duplicate check also avoids re-reading expenses on repeated triggers.
    if ((await claimRef.get()).exists) { stats.duplicates++; continue; }
    // Includes legacy records where missing method means manual. One query per
    // opted-in account per day; filtering in memory avoids migration writes.
    const expenses = await db.collection('users').doc(uid).collection('expenses').get();
    const due = expenses.docs.map(d => d.data()).filter(e => dueToday(e, today))
      .sort((a, b) => cleanTitle(a.title).localeCompare(cleanTitle(b.title), 'en-GB'));
    stats.duePayments += due.length;
    const notice = content(due, today);
    if (!notice || dryRun) continue;
    const claimed = await db.runTransaction(async tx => {
      if ((await tx.get(claimRef)).exists) return false;
      tx.create(claimRef, { day: today, claimedAt: now });
      return true;
    });
    if (!claimed) { stats.duplicates++; continue; }
    stats.claimed++;
    // Retain the claim after an ambiguous send/crash: do not create duplicate
    // daily alerts. FCM acceptance does not guarantee display on a device.
    if (clock() >= expiresAt) continue;
    try {
      const result = await messaging.sendEachForMulticast({
        tokens: devices.map(d => d.data().token),
        data: { ...notice, kind: 'daily', uid, deliveryId: id, notifyDay: today, expiresAt: String(expiresAt) },
        webpush: { headers: { TTL: String(Math.max(0, Math.floor((expiresAt - clock()) / 1000))), Urgency: 'normal' } }
      });
      for (let i = 0; i < result.responses.length; i++) {
        const response = result.responses[i];
        if (response.success) { stats.sent++; continue; }
        stats.failed++;
        if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(response.error?.code)) {
          const device = devices[i];
          await db.runTransaction(async tx => {
            const fresh = await tx.get(device.ref);
            if (fresh.exists && fresh.data().token === device.data().token) tx.delete(device.ref);
          });
          stats.invalidTokens++;
        }
      }
    } catch { stats.failed += devices.length; }
  }
  return stats;
}
module.exports = { ukDay, nextMidnight, dueToday, content, deliveryId, runDaily };
