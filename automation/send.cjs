const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { runDaily } = require('./reminders.cjs');
const { appendFileSync } = require('node:fs');
async function main() {
  if (process.env.FIREBASE_PROJECT_ID !== 'budget-app-283de') throw new Error('Unexpected project');
  const now = Date.now();
  const run = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!run.ok) throw new Error('Could not verify run date');
  const scheduledAt = Date.parse((await run.json()).created_at);
  if (!Number.isFinite(scheduledAt)) throw new Error('Invalid run date');
  initializeApp({ credential: applicationDefault(), projectId: 'budget-app-283de' });
  const dryRun = process.env.REMINDERS_DRY_RUN !== 'false';
  const stats = await runDaily({ db: getFirestore(), messaging: getMessaging(), now, scheduledAt, dryRun });
  const output = JSON.stringify({ dryRun, ...stats });
  console.log('Budget Planner reminder counts', output);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nBudget Planner reminder counts\n\n\`\`\`json\n${output}\n\`\`\`\n`);
  if (stats.failed) process.exitCode = 1;
}
main().catch(() => {
  // Never expose raw errors, account data, message bodies, tokens or credentials.
  console.error('Budget Planner reminder check failed. Check Firebase identity, project, IAM permissions and collection-group index setup.');
  process.exitCode = 1;
});
