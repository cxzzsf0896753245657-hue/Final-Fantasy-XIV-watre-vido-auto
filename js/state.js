/* 共用資料與工具函式
   專案資料都放在 HC.state 裡：
   - clips：匯入的素材（檔案本身只存在瀏覽器記憶體，不會上傳）
   - shots：時間軸上的鏡頭，依序播放
   - title / music / out / auto：各分頁的設定
*/
window.HC = window.HC || {};
{
  const HC = window.HC;

  HC.state = {
    clips: [],
    shots: [],
    title: { show: true, main: "FFXIV HOUSING", sub: "庭園 ・ Garden", font: "Noto Serif TC", size: 84, color: "#ffffff", pos: "center", line: true, dur: 5.5 },
    music: { name: "", url: "", vol: 0.8, off: 0, fade: 3 },
    out: { res: 1080, rate: 10, fi: 1.5, fo: 2.5 },
    auto: { len: 120, rhythm: 0.4, speed: 0.8, zoom: 0.16, tol: 0.5, head: 0.5, cursor: true, ui: true, stab: true, stabStr: 0.6, learn: true, cover: true, lateral: true, gap: 8 },
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

  /* 每個鏡頭在成品裡的開始時間 */
  HC.timeline = () => {
    const starts = [];
    let t = 0;
    for (const s of HC.state.shots) { starts.push(t); t += HC.outDur(s); }
    return { starts, total: t };
  };
  HC.shotAt = (T) => {
    const { starts, total } = HC.timeline();
    const n = HC.state.shots.length;
    if (!n) return null;
    T = HC.clamp(T, 0, Math.max(0, total - 1e-3));
    let i = n - 1;
    for (let k = 0; k < n; k++) if (T < starts[k] + HC.outDur(HC.state.shots[k])) { i = k; break; }
    return { i, off: T - starts[i] };
  };

  /* 從檔名讀出拍攝時間，例如 FINAL_FANTASY_XIV_2026-11-10_13-38-25.mp4 */
  HC.fileTime = (name, fallback) => {
    const m = name.match(/(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return fallback || 0;
  };

  /* ---------- 復原／重做 ---------- */
  const past = [], future = [];
  const snap = () => JSON.stringify({ shots: HC.state.shots, title: HC.state.title, ex: HC.state.clips.map((c) => [c.id, c.excluded]) });
  const restore = (j) => {
    const o = JSON.parse(j);
    HC.state.shots = o.shots;
    HC.state.title = o.title;
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
