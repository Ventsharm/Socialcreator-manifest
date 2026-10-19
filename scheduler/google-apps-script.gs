/**
 * Budget Planner: Google Apps Script -> GitHub Actions daily reminder scheduler.
 * NO Firebase reads or secrets in this public source.
 * Copy to a PRIVATE Google Apps Script project.
 * Store a repository-restricted GitHub token in Script Properties as GITHUB_TOKEN.
 */
const BUDGET_SCHEDULER = Object.freeze({
  owner: 'Ventsharm',
  repo: 'Socialcreator-manifest',
  workflow: 'daily-reminders.yml',
  branch: 'main',
  timezone: 'Europe/London'
});

// STEP 1. Verify private token and grant Google's URL-fetch permission.
function verifyGitHubAccess() {
  const token = githubToken_();
  const url = 'https://api.github.com/repos/' + BUDGET_SCHEDULER.owner + '/' +
    BUDGET_SCHEDULER.repo + '/actions/workflows/' + BUDGET_SCHEDULER.workflow;
  const result = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: githubHeaders_(token),
    muteHttpExceptions: true
  });
  if (result.getResponseCode() !== 200) {
    throw new Error('GitHub workflow access failed: HTTP ' + result.getResponseCode() +
      '. Check the token and Actions: Read and write permission.');
  }
  console.log('GitHub access OK. No Firebase access or writes.');
}

// STEP 2. Install exactly one automatic test at least two minutes from now.
function scheduleOneTimeTest() {
  verifyGitHubAccess();
  deleteTriggers_('sendOneTimeTest');
  ScriptApp.newTrigger('sendOneTimeTest').timeBased().after(2 * 60 * 1000).create();
  console.log('Live automatic test queued for no earlier than two minutes from now.');
}

// Google calls this on a timer; does a REAL, non-dry-run production check.
function sendOneTimeTest() {
  deleteTriggers_('sendOneTimeTest');
  dispatchOncePerUkDay_('apps-script-test');
}

// STEP 3. After test succeeds, install one daily trigger ~09:30 UK.
function enableDailyAt930UK() {
  verifyGitHubAccess();
  deleteTriggers_('sendDailyReminders');
  ScriptApp.newTrigger('sendDailyReminders').timeBased()
    .atHour(9).nearMinute(30).everyDays(1)
    .inTimezone(BUDGET_SCHEDULER.timezone).create();
  console.log('Daily trigger enabled for ~09:30 UK time (allow +/- 15 minutes).');
}

function sendDailyReminders() {
  dispatchOncePerUkDay_('apps-script-daily');
}

function showSetupStatus() {
  const p = PropertiesService.getScriptProperties();
  const names = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  console.log(JSON.stringify({
    tokenConfigured: Boolean(p.getProperty('GITHUB_TOKEN')),
    oneTimeTestPending: names.includes('sendOneTimeTest'),
    dailyEnabled: names.includes('sendDailyReminders'),
    lastAcceptedDispatchUkDay: p.getProperty('LAST_DISPATCH_UK_DAY') || null
  }));
}

function disableDaily() {
  deleteTriggers_('sendDailyReminders');
  console.log('Google daily trigger disabled.');
}

function dispatchOncePerUkDay_(source) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Scheduler lock could not be obtained.');
  try {
    const props = PropertiesService.getScriptProperties();
    const day = Utilities.formatDate(new Date(), BUDGET_SCHEDULER.timezone, 'yyyy-MM-dd');
    if (props.getProperty('LAST_DISPATCH_UK_DAY') === day) {
      console.log('Skipped second Google dispatch for ' + day);
      return;
    }
    const url = 'https://api.github.com/repos/' + BUDGET_SCHEDULER.owner + '/' +
      BUDGET_SCHEDULER.repo + '/actions/workflows/' + BUDGET_SCHEDULER.workflow + '/dispatches';
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: githubHeaders_(githubToken_()),
      payload: JSON.stringify({
        ref: BUDGET_SCHEDULER.branch,
        inputs: { dry_run: 'false', trigger_source: source }
      }),
      muteHttpExceptions: true
    });
    const status = response.getResponseCode();
    if (status !== 204 && status !== 200) {
      throw new Error('GitHub rejected dispatch: HTTP ' + status +
        '. Check token permission and workflow inputs.');
    }
    // A successful API response means GitHub accepted the trigger, NOT FCM delivery.
    // Prevent repeated Google dispatches on the same UK calendar day.
    props.setProperty('LAST_DISPATCH_UK_DAY', day);
    console.log('GitHub accepted ' + source + ' for ' + day +
      '. Inspect the labelled GitHub Actions run for actual send results.');
  } finally {
    lock.releaseLock();
  }
}

function githubToken_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token || !token.trim()) {
    throw new Error('Missing GITHUB_TOKEN: add it under Project Settings > Script properties.');
  }
  return token.trim();
}

function githubHeaders_(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
}
