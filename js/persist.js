/* 自動存檔（存在這個瀏覽器的 IndexedDB 裡，不會上傳）
   - 專案：每幾秒檢查一次，有改就存；下次打開網頁可以「繼續上次的專案」
   - 素材分析結果：依「檔名＋檔案大小」記住，同一支素材再匯入就不用重新分析
   - 素材檔案的「捷徑」（Chrome／Edge 的 File System Access）：用「匯入素材」按鈕或拖進來的檔案會記住位置，
     繼續上次的專案時按一下允許，就不用再一支一支重新匯入
   瀏覽器不支援或被擋（例如無痕模式、內嵌頁面）時，這些功能會安靜地跳過，不影響剪輯。
*/
{
  const HC = window.HC;
  const DB = "housingcut", VER = 1;
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res) => {
    try {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => { const d = r.result; for (const s of ["proj", "ana", "handles"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch (e) { res(null); }
  }));
  const tx = async (store, mode, fn) => {
    const d = await open(); if (!d) return null;
    return new Promise((res) => {
      try {
        const t = d.transaction(store, mode), st = t.objectStore(store), r = fn(st);
        t.oncomplete = () => res(r && "result" in r ? r.result : true);
        t.onerror = t.onabort = () => res(null);
      } catch (e) { res(null); }
    });
  };
  const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
  const put = (store, key, val) => tx(store, "readwrite", (s) => s.put(val, key));
  const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));

  /* ---------- 分析結果快取 ---------- */
  const anaKey = (c) => `${c.name}|${c.size || 0}`;
  HC.anaCache = {
    get: (c) => get("ana", anaKey(c)),
    put: (c) => c.ana && put("ana", anaKey(c), { ana: c.ana, dur: c.dur, w: c.w, h: c.h, v: HC.ANA_VER, at: Date.now() }),
  };

  /* ---------- 檔案捷徑 ---------- */
  HC.fileHandles = {
    put: (name, h) => h && put("handles", name, h),
    get: (name) => get("handles", name),
    /* 取得檔案：需要時會跳出「允許讀取」的詢問（要在按鈕點擊裡呼叫） */
    async file(name) {
      const h = await get("handles", name);
      if (!h || !h.getFile) return null;
      try {
        let p = await h.queryPermission({ mode: "read" });
        if (p !== "granted") p = await h.requestPermission({ mode: "read" });
        return p === "granted" ? await h.getFile() : null;
      } catch (e) { return null; }
    },
  };
  HC.canPickFiles = () => { try { return typeof window.showOpenFilePicker === "function" && window.self === window.top; } catch (e) { return false; } };

  /* ---------- 專案自動存檔 ---------- */
  let last = "", timer = null;
  HC.autosave = {
    start(getJSON) {
      clearInterval(timer);
      const tick = () => {
        try {
          if (!HC.state.shots.length && !HC.state.clips.length) return;
          const j = getJSON();
          if (j === last) return;
          last = j;
          put("proj", "current", { json: j, at: Date.now() });
        } catch (e) {}
      };
      timer = setInterval(tick, 4000);
      addEventListener("pagehide", tick);
      document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && tick());
    },
    load: () => get("proj", "current"),
    clear: () => { last = ""; return del("proj", "current"); },
    mark: (j) => { last = j; },
    // 專案版本：手動存的快照（最多 20 個）
    versions: async () => (await get("proj", "versions")) || [],
    saveVersions: (list) => put("proj", "versions", list.slice(-20)),
    // 音樂庫的音樂只記編號，自己的音樂檔才存檔案本身
    saveMusic: (f, lib) => put("proj", "music", lib ? { name: f.name, lib } : { name: f.name, blob: f }),
    saveAmb: (key, name, blob) => put("proj", "amb:" + key, { name, blob }),
    dropAmb: (key) => del("proj", "amb:" + key),
    amb: (key) => get("proj", "amb:" + key),
    music: () => get("proj", "music"),
    clearMusic: () => del("proj", "music"),
  };
}
