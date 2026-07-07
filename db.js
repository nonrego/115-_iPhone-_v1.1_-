(function () {
  "use strict";

  const DB_NAME = "cyjh-inventory-115";
  const DB_VERSION = 2;

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("records")) {
          const records = db.createObjectStore("records", { keyPath: "assetId" });
          records.createIndex("updatedAt", "updatedAt", { unique: false });
          records.createIndex("expectedLocation", "expectedLocation", { unique: false });
        }
        if (!db.objectStoreNames.contains("photos")) {
          db.createObjectStore("photos", { keyPath: "assetId" });
        }
        if (!db.objectStoreNames.contains("unlabeled")) {
          const unlabeled = db.createObjectStore("unlabeled", { keyPath: "tempId" });
          unlabeled.createIndex("updatedAt", "updatedAt", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transaction(storeName, mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result;
      try {
        result = action(store);
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || new Error("資料庫交易已中止"));
      };
    });
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  window.InventoryDb = {
    async getAllRecords() {
      const db = await openDb();
      try {
        return await requestResult(db.transaction("records", "readonly").objectStore("records").getAll());
      } finally {
        db.close();
      }
    },

    async getRecord(assetId) {
      const db = await openDb();
      try {
        return await requestResult(db.transaction("records", "readonly").objectStore("records").get(assetId));
      } finally {
        db.close();
      }
    },

    async putRecord(record) {
      return transaction("records", "readwrite", (store) => store.put(record));
    },

    async getAllPhotos() {
      const db = await openDb();
      try {
        return await requestResult(db.transaction("photos", "readonly").objectStore("photos").getAll());
      } finally {
        db.close();
      }
    },

    async getPhoto(assetId) {
      const db = await openDb();
      try {
        return await requestResult(db.transaction("photos", "readonly").objectStore("photos").get(assetId));
      } finally {
        db.close();
      }
    },

    async putPhoto(photo) {
      return transaction("photos", "readwrite", (store) => store.put(photo));
    },

    async getAllUnlabeled() {
      const db = await openDb();
      try {
        return await requestResult(db.transaction("unlabeled", "readonly").objectStore("unlabeled").getAll());
      } finally {
        db.close();
      }
    },

    async putUnlabeled(item) {
      return transaction("unlabeled", "readwrite", (store) => store.put(item));
    },

    async clearAll() {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(["records", "photos", "unlabeled"], "readwrite");
        tx.objectStore("records").clear();
        tx.objectStore("photos").clear();
        tx.objectStore("unlabeled").clear();
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      });
    },
  };
})();
