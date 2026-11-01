/**
 * Minimal promise wrapper around one IndexedDB key/value store. Values are stored by structured
 * clone (no JSON round-trip), so large datasets are cheap to write and have no 5 MB cap.
 *
 * The dataset copy is stored in pieces (see ./sync `persistBase`): a meta record plus one key
 * per collection, with days and sessions split per year, so an edit rewrites only the piece it
 * touched instead of years of history.
 */
const DB_NAME = "strawvine";
const STORE = "kv";

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      db.onclose = () => {
        dbp = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  }).catch((e: unknown) => {
    dbp = null;
    throw e;
  });
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = tx.onabort = () => reject(tx.error ?? req.error ?? new Error("IndexedDB transaction failed"));
      }),
  );
}

export const idbGet = <T>(key: string) => run<T | undefined>("readonly", (s) => s.get(key));
export const idbSet = (key: string, value: unknown) => run<unknown>("readwrite", (s) => s.put(value, key)).then(() => undefined);
export const idbDel = (key: string) => run<unknown>("readwrite", (s) => s.delete(key)).then(() => undefined);
/** Deletes everything this app keeps in IndexedDB. */
export const idbClear = () => run<unknown>("readwrite", (s) => s.clear()).then(() => undefined);

/**
 * Reads `metaKey`, then (in the same transaction, so a concurrent writer can't interleave) the
 * keys `keysOf(meta)` names. Resolves with the meta record and a key → value map.
 */
export function idbReadSet<M>(
  metaKey: string,
  keysOf: (meta: M | undefined) => string[],
): Promise<{ meta: M | undefined; values: Map<string, unknown> }> {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        const values = new Map<string, unknown>();
        let meta: M | undefined;
        const mreq = store.get(metaKey);
        mreq.onsuccess = () => {
          meta = mreq.result as M | undefined;
          for (const k of keysOf(meta)) {
            const r = store.get(k);
            r.onsuccess = () => values.set(k, r.result);
          }
        };
        tx.oncomplete = () => resolve({ meta, values });
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB read failed"));
      }),
  );
}

export interface WritePlan {
  puts: [string, unknown][];
  dels: string[];
}

/**
 * Atomic check-and-write: reads `metaKey`, asks `plan(meta)` what to write (null = nothing, the
 * transaction is dropped), then issues one put at a time — each in the previous one's success
 * callback, so the structured-clone work is spread over several short tasks instead of one long
 * one. Resolves true when the plan was committed, false when `plan` declined.
 */
export function idbWritePlanned<M>(metaKey: string, plan: (meta: M | undefined) => WritePlan | null): Promise<boolean> {
  return open().then(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        let wrote = false;
        const mreq = store.get(metaKey);
        mreq.onsuccess = () => {
          let p: WritePlan | null;
          try {
            p = plan(mreq.result as M | undefined);
          } catch (e) {
            tx.abort();
            reject(e);
            return;
          }
          if (!p) return; // nothing requested: the transaction just completes
          wrote = true;
          for (const k of p.dels) store.delete(k);
          const puts = p.puts;
          let i = 0;
          const next = () => {
            if (i >= puts.length) return;
            const [k, v] = puts[i++]!;
            const r = store.put(v, k);
            r.onsuccess = next;
          };
          next();
        };
        tx.oncomplete = () => resolve(wrote);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write failed"));
      }),
  );
}
