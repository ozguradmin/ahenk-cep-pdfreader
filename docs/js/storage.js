// The work, kept on the device (IndexedDB), so that a closed tab, a reload or a crash loses nothing: a job's
// segments and settings, and each segment's MP3 bytes as it is made. A Blob read back from IndexedDB lives on disk,
// not in the page's memory, so even a book-length job holds only a little memory. Nothing leaves the device.
//
// jobs:   {id, name, file, created, updated, steps, speed, n, made, seconds, state, synthMs, position, downloaded}
// texts:  {id, segs}  (the segments to speak; written once, kept apart so progress updates stay small)
// chunks: {job, index, mp3 (Blob), samples, peaks (Uint8Array), failed}  key [job, index]
//
// Every call fails soft: without IndexedDB (some private windows) openStore() gives null and the page keeps the
// audio in memory as before.

const DB = 'ahenk-okur';
const KEEP = 3; // jobs kept; older ones are deleted when a new one starts

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

export async function openStore() {
  try {
    if (!self.indexedDB) return null;
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('jobs', { keyPath: 'id' });
      db.createObjectStore('texts', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['job', 'index'] });
    };
    const db = await Promise.race([req(open), new Promise((_, rej) => { setTimeout(() => rej(new Error('IndexedDB timeout')), 5000); })]);
    // a probe write: Firefox private windows open the database but refuse Blobs
    const tx = db.transaction('chunks', 'readwrite');
    tx.objectStore('chunks').put({ job: '_probe', index: 0, mp3: new Blob([new Uint8Array(1)]) });
    tx.objectStore('chunks').delete(['_probe', 0]);
    await done(tx);
    return new Store(db);
  } catch (e) {
    console.warn('Ahenk Okur: no persistent storage, audio stays in memory.', e);
    return null;
  }
}

class Store {
  constructor(db) {
    this.db = db;
  }

  async saveJob(meta, segs) {
    const tx = this.db.transaction(['jobs', 'texts'], 'readwrite');
    tx.objectStore('jobs').put({ ...meta, updated: Date.now() });
    if (segs) tx.objectStore('texts').put({ id: meta.id, segs });
    await done(tx);
  }

  async text(id) {
    const tx = this.db.transaction('texts', 'readonly');
    const row = await req(tx.objectStore('texts').get(id));
    return row ? row.segs : null;
  }

  async patchJob(id, fields) {
    const tx = this.db.transaction('jobs', 'readwrite');
    const s = tx.objectStore('jobs');
    const meta = await req(s.get(id));
    if (meta) s.put({ ...meta, ...fields, updated: Date.now() });
    await done(tx);
  }

  // stores the chunk and gives back the stored Blob (disk-backed), so the page can drop its in-memory copy
  async putChunk(id, index, chunk) {
    const tx = this.db.transaction('chunks', 'readwrite');
    const s = tx.objectStore('chunks');
    s.put({ job: id, index, ...chunk });
    const back = req(s.get([id, index]));
    await done(tx);
    const row = await back;
    return row ? row.mp3 : chunk.mp3;
  }

  async chunks(id) {
    const tx = this.db.transaction('chunks', 'readonly');
    const range = IDBKeyRange.bound([id, 0], [id, Infinity]);
    const rows = await req(tx.objectStore('chunks').getAll(range));
    return rows.sort((a, b) => a.index - b.index);
  }

  // from segment `from` on, in case a job restarts from an earlier point
  async dropChunks(id, from = 0) {
    const tx = this.db.transaction('chunks', 'readwrite');
    tx.objectStore('chunks').delete(IDBKeyRange.bound([id, from], [id, Infinity]));
    await done(tx);
  }

  async jobs() {
    const tx = this.db.transaction('jobs', 'readonly');
    const all = await req(tx.objectStore('jobs').getAll());
    return all.sort((a, b) => b.updated - a.updated);
  }

  async deleteJob(id) {
    const tx = this.db.transaction(['jobs', 'texts', 'chunks'], 'readwrite');
    tx.objectStore('jobs').delete(id);
    tx.objectStore('texts').delete(id);
    tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
    await done(tx);
  }

  // keeps the newest KEEP - 1 jobs besides `keepId`
  async prune(keepId) {
    const all = await this.jobs();
    const others = all.filter((j) => j.id !== keepId);
    for (const j of others.slice(KEEP - 1)) await this.deleteJob(j.id);
  }
}

export async function storageUse() {
  try {
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
  } catch {
    return null;
  }
}
