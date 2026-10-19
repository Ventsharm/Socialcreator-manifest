const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
test('new Google script keeps working verification/test/daily structure and only dispatches Budget Planner once per UK day', () => {
  const props = new Map([['GITHUB_TOKEN', 'private-placeholder']]), calls = [], triggers = [];
  const context = vm.createContext({
    console: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key), setProperty: (key, value) => props.set(key, value) }) },
    Utilities: { formatDate: (date, zone, format) => { assert.equal(zone, 'Europe/London'); assert.equal(format, 'yyyy-MM-dd'); return '2026-10-01'; } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    UrlFetchApp: { fetch: (url, options) => { calls.push({ url, options }); return { getResponseCode: () => options.method === 'get' ? 200 : 204 }; } },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: handler => {
      const trigger = { timeBased: () => trigger, after: delay => { assert(delay >= 120000); return trigger; },
        atHour: hour => { assert.equal(hour, 9); return trigger; }, nearMinute: minute => { assert.equal(minute, 30); return trigger; },
        everyDays: days => { assert.equal(days, 1); return trigger; }, inTimezone: zone => { assert.equal(zone, 'Europe/London'); return trigger; },
        create: () => triggers.push(handler) };
      return trigger;
    } }
  });
  vm.runInContext(fs.readFileSync('scheduler/google-apps-script.gs', 'utf8'), context);
  context.verifyGitHubAccess(); context.scheduleOneTimeTest(); context.enableDailyAt930UK();
  assert(triggers.includes('sendOneTimeTest')); assert(triggers.includes('sendDailyReminders'));
  context.sendOneTimeTest(); context.sendDailyReminders();
  const dispatches = calls.filter(c => c.options.method === 'post'); assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].url, 'https://api.github.com/repos/Ventsharm/Socialcreator-manifest/actions/workflows/daily-reminders.yml/dispatches');
  assert.equal(JSON.parse(dispatches[0].options.payload).inputs.dry_run, 'false');
  assert.equal(JSON.parse(dispatches[0].options.payload).inputs.trigger_source, 'apps-script-test');
});
