/* 共用資料與工具函式
   專案資料都放在 HC.state 裡：
   - clips：匯入的素材（檔案本身只存在瀏覽器記憶體，不會上傳）
   - shots：時間軸上的鏡頭，依序播放
   - title / ending / look / music / out / auto：各分頁的設定
*/
window.HC = window.HC || {};
{
  const HC = window.HC;

  HC.state = {
    clips: [],
    shots: [],
    title: { template: "classic", main: "FFXIV HOUSING", sub: "庭園 ・ Garden", info: "", font: "Noto Serif TC", size: 84, color: "#ffffff", accent: "#e9c46a", pos: "center", line: true, dur: 5.5 },
    ending: { template: "none", main: "Thank you for watching", sub: "", info: "", dur: 4 },
    look: { filter: "none", fx: { vignette: 0, glow: 0, bokeh: 0, petals: 0, grain: 0, letterbox: 0 } },
    music: { name: "", url: "", vol: 0.8, off: 0, fade: 3 },
    out: { res: 1080, rate: 10, fi: 1.5, fo: 2.5 },
    auto: { len: 120, rhythm: 0.4, speed: 0.8, zoom: 0.16, tol: 0.5, head: 0.5, cursor: true, ui: true, stab: true, stabStr: 0.6, learn: true, cover: true, lateral: true, gap: 8, trMode: "learn", trType: "cut", order: "learn" },
  };

  let uid = 1;
  HC.uid = (p) => p + (uid++).toString(36) + Math.random().toString(36).slice(2, 5);

  HC.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  HC.fmt = (s) => {
    s = Math.max(0, s || 0);
    const m = Math.floor(s / 60);
    return m + ":" + (s - m * 60).toFixed(1).padStart(4, "0");
  };
  HC.clip = (id) => HC.state.clips.find((c) => c.id === id);
  HC.outDur = (s) => s.dur / s.speed;

  /* 轉場長度：第 i 個鏡頭「進場」的轉場，最多佔前後兩個鏡頭各一半 */
  HC.trDur = (i) => {
    const sh = HC.state.shots, s = sh[i], p = sh[i - 1];
    if (!s || !p || !s.tr || s.tr.type === "cut") return 0;
    return HC.clamp(s.tr.dur || 0.8, 0.1, Math.min(HC.outDur(p), HC.outDur(s)) * 0.5);
  };
  /* 每個鏡頭在成品裡的開始時間（有轉場時，下一個鏡頭會提早開始、和上一個重疊） */
  HC.timeline = () => {
    const starts = [], sh = HC.state.shots;
    let t = 0;
    for (let i = 0; i < sh.length; i++) {
      if (i) t = starts[i - 1] + HC.outDur(sh[i - 1]) - HC.trDur(i);
      starts.push(t);
    }
    const n = sh.length;
    return { starts, total: n ? starts[n - 1] + HC.outDur(sh[n - 1]) : 0 };
  };
  HC.shotAt = (T) => {
    const { starts, total } = HC.timeline();
    const n = HC.state.shots.length;
    if (!n) return null;
    T = HC.clamp(T, 0, Math.max(0, total - 1e-3));
    let i = 0;
    for (let k = 0; k < n; k++) if (starts[k] <= T) i = k;
    const overlap = i > 0 && T < starts[i] + HC.trDur(i);
    return { i, off: T - starts[i], overlap };
  };
  /* 舊版的「黑場」勾選轉成新的轉場格式 */
  HC.migrateShot = (s) => {
    if (!s.tr) s.tr = s.dip ? { type: "black", dur: 1.2 } : { type: "cut", dur: 0 };
    delete s.dip;
    return s;
  };

  /* 從檔名讀出拍攝時間，例如 FINAL_FANTASY_XIV_2026-11-10_13-38-25.mp4 */
  HC.fileTime = (name, fallback) => {
    const m = name.match(/(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return fallback || 0;
  };

  /* ---------- 復原／重做 ---------- */
  const past = [], future = [];
  const snap = () => JSON.stringify({ shots: HC.state.shots, title: HC.state.title, ending: HC.state.ending, look: HC.state.look, ex: HC.state.clips.map((c) => [c.id, c.excluded]) });
  const restore = (j) => {
    const o = JSON.parse(j);
    HC.state.shots = o.shots;
    HC.state.title = o.title; HC.state.ending = o.ending; HC.state.look = o.look;
    for (const [id, ex] of o.ex) { const c = HC.clip(id); if (c) c.excluded = ex; }
  };
  HC.commit = () => { past.push(snap()); if (past.length > 80) past.shift(); future.length = 0; };
  HC.undo = () => { if (!past.length) return false; future.push(snap()); restore(past.pop()); return true; };
  HC.redo = () => { if (!future.length) return false; past.push(snap()); restore(future.pop()); return true; };

  /* ---------- 等待影片事件 ---------- */
  HC.once = (el, ev, ms = 8000) => new Promise((res, rej) => {
    const t = setTimeout(() => { cleanup(); rej(new Error("timeout " + ev)); }, ms);
    const ok = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(new Error("media error")); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener("error", bad); };
    el.addEventListener(ev, ok);
    el.addEventListener("error", bad);
  });

  /* ---------- 縮圖（排隊產生，避免同時開太多影片） ---------- */
  const thumbCache = new Map();
  const queue = [];
  let busy = false;
  const tv = document.createElement("video");
  tv.muted = true; tv.playsInline = true; tv.preload = "auto";
  const tc = document.createElement("canvas");
  tc.width = 192; tc.height = 108;
  const tctx = tc.getContext("2d");

  HC.thumb = (clip, t) => {
    const key = clip.id + "@" + (Math.round(t * 2) / 2);
    if (thumbCache.has(key)) return Promise.resolve(thumbCache.get(key));
    return new Promise((res) => { queue.push({ clip, t, key, res }); pump(); });
  };
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const j = queue.shift();
      if (thumbCache.has(j.key)) { j.res(thumbCache.get(j.key)); continue; }
      try {
        if (tv.dataset.clip !== j.clip.id) { tv.src = j.clip.url; tv.dataset.clip = j.clip.id; await HC.once(tv, "loadeddata"); }
        tv.currentTime = HC.clamp(j.t, 0, (tv.duration || 1) - 0.05);
        await HC.once(tv, "seeked");
        // 等畫面真的解碼出來再截圖，避免拿到黑畫面
        if ("requestVideoFrameCallback" in tv) await new Promise((r) => { const to = setTimeout(r, 250); tv.requestVideoFrameCallback(() => { clearTimeout(to); r(); }); });
        tctx.drawImage(tv, 0, 0, 192, 108);
        const url = tc.toDataURL("image/jpeg", 0.7);
        thumbCache.set(j.key, url);
        j.res(url);
      } catch (e) { j.res(""); }
    }
    busy = false;
  }
}
