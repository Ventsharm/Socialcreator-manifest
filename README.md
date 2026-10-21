# Budget Planner — Android download page

The website application is retired. This repository now hosts a static Google Play download page for `io.github.ventsharm.twa`, styled after the established Bubblewrap safeguard.

The old web application, Firebase web configuration, push code, Apps Script scheduler source, reminder/test workflows, Node dependencies and web tests have been removed. Git history preserves prior source. Account and Firestore data remain unchanged and continue to serve the native Android app.

`service-worker.js` is a small retirement worker kept at the old URL so installed web versions can clear only their own `socialcreator-budget-cache-` caches and unregister. It performs no Firebase reads or notification sends. Other applications' workers and caches are untouched.

The domain-root saved-login association remains in the separate `Ventsharm/ventsharm.github.io` repository at `/.well-known/assetlinks.json`.

Google Play: https://play.google.com/store/apps/details?id=io.github.ventsharm.twa
