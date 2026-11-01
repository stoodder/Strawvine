/**
 * Minimal promise wrapper around one IndexedDB key/value store. Values are stored by structured
 * clone (no JSON round-trip), so large datasets are cheap to write and have no 5 MB cap.
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
