# Budget Planner notifications

## Current setup

- New Google Apps Script: [Budget Planner](https://script.google.com/d/1RZ30wCu9pxyWgRbkj_9Lit7j_3mK-1ztL8eZEbfotI7FM-IyeMKVZv5J/edit). The script and UK-time manifest are uploaded.
- Dedicated Firebase sender identity, keyless GitHub trust, required APIs and token security rules are configured in `budget-app-283de`.
- The GitHub workflow uses the public provider and service-account names directly; no repository variables are needed.
- The project-specific public Web Push certificate key is configured; device registration is enabled.
- [GitHub-to-Firebase dry run passed](https://github.com/Ventsharm/Socialcreator-manifest/actions/runs/39227394665) without writes or sends.
- Still required: add a new repository-restricted `GITHUB_TOKEN` privately in the new script’s properties, run the automatic test, then enable the daily trigger. Do not reuse Yearly Budget’s token or trigger.

The sections below remain as a setup reference. Do not recreate resources already configured.

The purple option is below the Incomes / Expenses / Overview tabs. After setup,
enabling registers this device and immediately displays a confirmation. A daily
check around **09:30 Europe/London** sends:

- On the **1st**, “New month: update when your incomes are due.”
- A single list of that account’s unpaid **manual** payments due today.
- If both apply, they share **one notification**, rather than one per payment.

This is a separate Budget Planner setup. **Do not modify the working Yearly Budget
script, its Firebase project, or its daily trigger.** The new script has the same
structure: private Google Apps Script → GitHub Actions → Firebase Admin / FCM.
No Firebase Cloud Functions or paid scheduler is required.

## 1. Firebase project: budget-app-283de

1. Open [Cloud Messaging settings](https://console.firebase.google.com/project/budget-app-283de/settings/cloudmessaging).
   Under **Web Push certificates**, generate a key pair if none exists. Copy the
   **public** key into `vapidKey` in `push-config.js`. Keep `enabled: false` for now.
   Never paste a service-account private key into public code or chat.
2. Open [Firestore rules](https://console.firebase.google.com/project/budget-app-283de/firestore/rules).
   Merge the fragment in [firestore-notification-rules.txt](../docs/firestore-notification-rules.txt)
   into the existing `match /databases/{database}/documents` block, preserving the
   existing income and expense rules. Verify that account A cannot read or write
   account B’s push tokens, and that clients cannot access root
   `budgetReminderDeliveries` documents. Broad overlapping rules must also respect
   these restrictions; `allow false` does not override another `allow true`.
3. Set up **a separate Budget Planner sender identity**, in this Firebase project.
   The following commands can run in your signed-in Google Cloud Shell, with
   project-owner/admin permission. They create a dedicated identity using the same
   keyless Workload Identity Federation structure as Yearly Budget. Run once;
   if a resource already exists, inspect and reuse it rather than replacing it.

```sh
gcloud config set project budget-app-283de
gcloud services enable firestore.googleapis.com fcm.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
gcloud iam service-accounts create budget-planner-sender --display-name="Budget Planner reminder sender"
gcloud projects add-iam-policy-binding budget-app-283de --member="serviceAccount:budget-planner-sender@budget-app-283de.iam.gserviceaccount.com" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding budget-app-283de --member="serviceAccount:budget-planner-sender@budget-app-283de.iam.gserviceaccount.com" --role="roles/firebasecloudmessaging.admin"
gcloud iam workload-identity-pools create budget-planner-reminders --location=global --display-name="Budget Planner GitHub reminders"
gcloud iam workload-identity-pools providers create-oidc github --location=global --workload-identity-pool=budget-planner-reminders --issuer-uri="https://token.actions.githubusercontent.com" --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" --attribute-condition="assertion.repository=='Ventsharm/Socialcreator-manifest' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='Ventsharm/Socialcreator-manifest/.github/workflows/daily-reminders.yml@refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding budget-planner-sender@budget-app-283de.iam.gserviceaccount.com --role="roles/iam.workloadIdentityUser" --member="principalSet://iam.googleapis.com/projects/162369707369/locations/global/workloadIdentityPools/budget-planner-reminders/attribute.repository/Ventsharm/Socialcreator-manifest"
```

4. The public provider and sender identity are already configured in `.github/workflows/daily-reminders.yml`. No private service-account JSON key is used.

5. Open [Budget Planner reminders](https://github.com/Ventsharm/Socialcreator-manifest/actions/workflows/daily-reminders.yml).
   Run the workflow on `main` with **dry_run checked**. It queries existing opted-in
   accounts and expenses but makes no writes and sends no notifications. Confirm
   it succeeds. With no registered device, counts will be zero.
6. Set `enabled: true` in `push-config.js`, retaining the public key. Reopen the
   app, sign in and tap **Enable notifications**. Accept the device permission;
   you should immediately receive a **Budget Planner notifications enabled** alert.
   Do not enable until token rules and the workflow identity are configured.
7. Run the dry run again with the device registered to verify expense reads as well
   as the token query. Existing income, expense, login and cache data are untouched.

## 2. New private Google Apps Script: Budget Planner

1. Create a repository-restricted [fine-grained GitHub token](https://github.com/settings/personal-access-tokens/new):
   owner **Ventsharm**, repository **Socialcreator-manifest**, repository permission
   **Actions: Read and write**. Save it privately; do not send it in chat.
2. Create a [new private Apps Script project](https://script.google.com/home/projects/create)
   named **Budget Planner**. Paste [google-apps-script.gs](./google-apps-script.gs)
   into its `Code.gs`. This script points to **Socialcreator-manifest**, not Yearly Budget.
3. In **Project Settings → Script properties**, add `GITHUB_TOKEN` with the token
   value. Never put the token in the source code.
4. Select `verifyGitHubAccess`, press **Run**, and grant Google’s URL-fetch permission.
5. Select `scheduleOneTimeTest` and run once. Wait at least two minutes for Google
   to call `sendOneTimeTest` automatically. This requests a **live** sender check,
   with `dry_run=false`. It sends only if there is an eligible alert today; it is
   not another generic test notification. A manual unpaid payment due today is a
   suitable test. Check the `apps-script-test` GitHub Actions run and the phone.
6. After a successful automatic test, select `enableDailyAt930UK` and run once.
   This installs one daily trigger at around **09:30 UK time**, allowing Google’s
   usual approximately ±15-minute scheduling window. BST changes are automatic.
7. `showSetupStatus` reports configuration without printing the token. `disableDaily`
   removes only this script’s daily trigger. There is **no GitHub cron** to duplicate it.

## How it behaves and what it costs

- Each enabled device registers its token on enable/change, with a refresh at most
  once per 30 days on later app opens. No token polling or heartbeat writes.
- The Google script does not read Firebase. It dispatches once per UK day using a
  script lock and `LAST_DISPATCH_UK_DAY`, exactly like the working Yearly Budget script.
- The sender reads registered device documents once daily, then one delivery-claim
  document and the expenses for each opted-in account. It never reads incomes.
  Existing documents are filtered in memory, avoiding a migration or extra writes
  on every expense edit. Empty Firestore queries can still incur a minimum read charge.
- Only accounts receiving a notification get **one new delivery-claim write per
  day**, regardless of the number of due manual payments. A repeated trigger skips
  accounts already claimed, without re-reading their expenses. No daily edits to
  income dates, expenses, paid flags or month buckets.
- Due dates follow the existing monthly expense display: the saved day in **This
  month**. **Next month**, paid and automatic items are excluded. A day beyond the
  month’s end uses the last day. Month buckets and paid flags keep their existing
  manual behavior; this feature does not reset or move them automatically.
- One alert per account per day **on each registered device**. Foreground and
  background delivery share a persistent duplicate check. Logging out suppresses
  that account’s notifications locally and attempts to remove its device token.
- Payment titles and amounts go into the device notification and may appear on its
  lock screen according to device settings. Very large lists are bounded by FCM’s
  payload size: the single alert shows the fitting items and a remaining count.
- FCM acceptance is not proof of display. Offline devices, denied permissions,
  expired GitHub tokens, Google delays or failed jobs can prevent an alert. Messages
  expire at the next UK midnight. Claims are retained after ambiguous send failures
  to avoid repeated alerts; there is no automatic retry after the day’s dispatch.
- The daily sender must finish within its GitHub Actions timeout. Inspect its
  summary counts if the user base grows; paginate/batch further before scaling.
- On iPhone/iPad, web push requires a supported OS/browser and opening the installed
  Home Screen web app. Notification support varies in embedded browsers.

## Validation and activation status

`npm test` exercises UK/BST boundaries, grouped sends, account isolation, duplicate
suppression, dry runs, worker restarts, logout suppression and cache preservation.
It does not prove delivery to a real phone. Complete both setup sections and the
automatic live test before calling the feature active. Device registration is enabled after the successful Firebase dry run. Scheduled delivery still requires the private Google token, automatic live test and daily trigger described above.
