/* Library — tiny IndexedDB wrapper that keeps imported tracks (audio blobs included)
 * so the queue survives reloads. Every method rejects if IndexedDB is unavailable;
 * callers treat persistence as best-effort.
 */
window.Library = (() => {
  'use strict';

  const DB_NAME = 'event-horizon';
  const STORE = 'tracks';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    all: () => run('readonly', (s) => s.getAll()),
    put: (record) => run('readwrite', (s) => s.put(record)),
    putMany: (records) => run('readwrite', (s) => { records.forEach((r) => s.put(r)); return null; }),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    clear: () => run('readwrite', (s) => s.clear()),
  };
})();
