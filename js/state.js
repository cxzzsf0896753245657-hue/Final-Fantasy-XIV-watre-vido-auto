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
    title: { template: "classic", main: "FFXIV HOUSING", sub: "庭園 ・ Garden", info: "", font: "Noto Serif TC", size: 84, color: "#ffffff", accent: "#e9c46a", pos: "auto", line: true, dur: 5.5 },
    ending: { template: "none", main: "Thank you for watching", sub: "", info: "", dur: 4 },
    wm: { on: false, kind: "text", text: "", img: "", corner: "br", size: 0.1, opacity: 0.75 },   // 浮水印
    look: { filter: "none", filterStr: 1, tintStr: 1, fx: { vignette: 0, glow: 0, bokeh: 0, petals: 0, grain: 0, letterbox: 0 } },
    music: { name: "", url: "", vol: 0.8, off: 0, fade: 3, lib: "" },
    amb: [],   // 環境音效（最多 3 層，整支影片循環播放）：{ key, name, url, vol, lib }
    out: { mode: "frames", fps: 30, aspect: "16:9", res: 1080, rate: 10, fi: 1.5, fo: 2.5 },
    auto: { len: 120, rhythm: 0.4, speed: 0.8, zoom: 0.16, tol: 0.5, head: 0.5, cursor: true, ui: true, stab: true, stabStr: 0.6, learn: true, cover: true, lateral: true, gap: 8, sceneLook: 0.5, trMode: "learn", trType: "cut", order: "learn", beat: true },
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
  /* 鏡頭時間 ↔ 素材時間
     - 速度曲線（s.ramp）：ease = 頭尾慢中間快、in = 慢慢加速、out = 慢慢減速；總長度不變
     - 定格（s.freeze 秒）：素材播完後停在最後一格 */
  const RAMP_A = 0.6;
  const RAMPS = {
    ease: [(u) => u - RAMP_A * Math.sin(2 * Math.PI * u) / (2 * Math.PI), (u) => 1 - RAMP_A * Math.cos(2 * Math.PI * u)],
    in: [(u) => u - RAMP_A * Math.sin(Math.PI * u) / Math.PI, (u) => 1 - RAMP_A * Math.cos(Math.PI * u)],
    out: [(u) => u + RAMP_A * Math.sin(Math.PI * u) / Math.PI, (u) => 1 + RAMP_A * Math.cos(Math.PI * u)],
  };
  const lin = [(u) => u, () => 1];
  const rampOf = (s) => (s.mode === "move" && RAMPS[s.ramp]) || lin;
  HC.moveDur = (s) => s.dur / s.speed;                       // 會動的部分
  HC.outDur = (s) => s.dur / s.speed + (s.freeze || 0);      // 加上定格
  HC.srcTime = (s, lt) => s.start + s.dur * rampOf(s)[0](HC.clamp(lt / HC.moveDur(s), 0, 1));
  HC.rateAt = (s, lt) => s.speed * rampOf(s)[1](HC.clamp(lt / HC.moveDur(s), 0, 1));
  HC.ltOfSrc = (s, src) => {   // 反過來：素材時間 → 鏡頭時間（二分搜尋，曲線是單調遞增的）
    const md = HC.moveDur(s), y = (src - s.start) / s.dur, F = rampOf(s)[0];
    if (F === lin[0]) return y * md;
    if (y <= 0) return y * md; if (y >= 1) return md + (y - 1) * md;
    let lo = 0, hi = 1;
    for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (F(m) < y) lo = m; else hi = m; }
    return (lo + hi) / 2 * md;
  };
  /* 自訂路徑：起點畫框 a → 終點畫框 b（x, y = 目標點 0～1，z = 放大倍率 ≥ 1） */
  HC.defaultPath = (s) => { const [x, y] = HC.focusOf(s); return { a: { x: 0.5, y: 0.5, z: 1 }, b: { x, y, z: 1 + Math.max(0.12, s.zoom || 0.15) } }; };
  HC.pathAt = (s, e) => {
    const p = s.kf || HC.defaultPath(s), m = (k) => p.a[k] + (p.b[k] - p.a[k]) * e;
    return { x: HC.clamp(m("x"), 0, 1), y: HC.clamp(m("y"), 0, 1), z: Math.max(1, m("z")) };
  };
  /* 每個鏡頭的調色：亮度、對比、飽和度（-1～1）＋色溫（-1 冷 ～ 1 暖） */
  HC.adjCss = (s) => {
    const a = s.adj; if (!a) return "";
    const f = [];
    if (a.b) f.push(`brightness(${(1 + a.b * 0.45).toFixed(3)})`);
    if (a.c) f.push(`contrast(${(1 + a.c * 0.45).toFixed(3)})`);
    if (a.s) f.push(`saturate(${(1 + a.s * 0.7).toFixed(3)})`);
    return f.join(" ");
  };
  HC.tempFill = (s) => {
    const t = s.adj && s.adj.t; if (!t) return "";
    return t > 0 ? `rgba(255,150,60,${(t * 0.45).toFixed(3)})` : `rgba(70,140,255,${(-t * 0.45).toFixed(3)})`;
  };
  /* 這一格要從素材裡裁哪一塊（素材像素座標）。st = 防抖位移（可省略） */
  const easeIO = (p) => 0.5 - 0.5 * Math.cos(Math.PI * HC.clamp(p, 0, 1));
  HC.cropAt = (s, lt, vw, vh, W, H, st, crop = 1) => {
    const od = HC.outDur(s), e = easeIO(Math.min(1, lt / od)), k = s.zoom || 0;
    let z = 1, [fx, fy] = HC.focusOf(s);
    switch (s.mode) {
      case "path": { const p = HC.pathAt(s, e); z = p.z; fx = p.x; fy = p.y; break; }
      case "in": z = 1 + k * e; break;
      case "out": z = 1 + k - k * e; break;
      case "panR": z = 1 + k; fx = e; break;
      case "panL": z = 1 + k; fx = 1 - e; break;
      case "panU": z = 1 + k; fy = 1 - e; break;
      case "panD": z = 1 + k; fy = e; break;
      case "none": z = 1 + k; break;
    }
    z *= crop;
    const sc = Math.max(W / vw, H / vh) * z, sw = W / sc, sh = H / sc;
    let sx = (vw - sw) * fx, sy = (vh - sh) * fy;
    if (st) { sx = HC.clamp(sx + st[0] * vw, 0, vw - sw); sy = HC.clamp(sy + st[1] * vh, 0, vh - sh); }
    return { sx, sy, sw, sh };
  };
  /* 素材上的一點（0～1）在畫面上的位置（0～1） */
  HC.toScreen = (cr, x, y, vw, vh) => [(x * vw - cr.sx) / cr.sw, (y * vh - cr.sy) / cr.sh];
  HC.RAMP_NAMES = { "": "等速", ease: "頭尾慢、中間快", in: "慢慢加速", out: "慢慢減速" };
  /* 成品畫面大小：res 是短邊（720／1080／2160），比例 16:9、9:16、1:1、4:5 */
  HC.ASPECTS = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:5": [4, 5] };
  HC.outSize = (res) => {
    const r = res || HC.state.out.res, s = r === 720 ? 720 : r === 2160 ? 2160 : 1080, [a, b] = HC.ASPECTS[HC.state.out.aspect] || HC.ASPECTS["16:9"];
    const even = (x) => Math.round(x / 2) * 2;
    return a >= b ? { W: even(s * a / b), H: s } : { W: s, H: even(s * b / a) };
  };
  // 不是 16:9 就要從素材裁一塊出來（目標點決定裁哪裡）
  HC.vertical = () => (HC.state.out.aspect || "16:9") !== "16:9";
  /* 鏡頭的目標點（推近的中心；直式時也決定保留畫面的哪一塊）：你設定的 > 自動找到的 > 正中央 */
  HC.focusOf = (s) => [s.fx ?? s.afx ?? 0.5, s.fy ?? s.afy ?? 0.5];

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
  const snap = () => JSON.stringify({ shots: HC.state.shots, title: HC.state.title, ending: HC.state.ending, look: HC.state.look, ex: HC.state.clips.map((c) => [c.id, c.excluded, c.sceneMark || "", c.stype || "", c.tod || ""]) });
  const restore = (j) => {
    const o = JSON.parse(j);
    HC.state.shots = o.shots;
    HC.state.title = o.title; HC.state.ending = o.ending; HC.state.look = o.look;
    for (const [id, ex, mk, st, td] of o.ex) { const c = HC.clip(id); if (c) { c.excluded = ex; c.sceneMark = mk || ""; c.stype = st || ""; c.tod = td || ""; } }
    HC.computeScenes && HC.computeScenes();
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
