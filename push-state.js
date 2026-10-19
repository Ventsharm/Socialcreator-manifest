/* Shared by the page and its existing service worker. No credentials stored here. */
(() => {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open("budget-planner-push", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("settings");
      request.result.createObjectStore("deliveries");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function setOwner(uid) {
    const db = await open();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("settings", "readwrite");
        tx.objectStore("settings").put(uid, "owner");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  // Atomically check the signed-in owner and record delivery before displaying.
  async function claim(uid, id, today) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(["settings", "deliveries"], "readwrite");
        let accepted = false;
        const deliveries = tx.objectStore("deliveries");
        const owner = tx.objectStore("settings").get("owner");
        owner.onsuccess = () => {
          if (owner.result !== uid) return;
          const existing = deliveries.get(id);
          existing.onsuccess = () => {
            if (existing.result) return;
            deliveries.put(today, id);
            accepted = true;
          };
        };
        const cursor = deliveries.openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          // Expired pushes are rejected by date; old browser dedup entries can go.
          if (row.value < today) row.delete();
          row.continue();
        };
        tx.oncomplete = () => resolve(accepted);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  globalThis.BudgetPushState = { setOwner, claim };
})();
