const open = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("designx-pending-documents", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("drafts");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
async function request(
  key: string,
  operation: "get" | "put" | "delete",
  value?: unknown,
) {
  const db = await open();
  try {
    return await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(
        "drafts",
        operation === "get" ? "readonly" : "readwrite",
      );
      const store = tx.objectStore("drafts");
      const req =
        operation === "get"
          ? store.get(key)
          : operation === "put"
            ? store.put(value, key)
            : store.delete(key);
      let result: any;
      req.onsuccess = () => {
        result = req.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export const draftCache = {
  get: (key: string) => request(key, "get"),
  put: (key: string, value: unknown) => request(key, "put", value),
  remove: (key: string) => request(key, "delete"),
};
