/* 學習
   兩個來源：
   1. 你的手動修改：自動剪輯後你刪掉、加入、改長度、換效果的鏡頭，都會被記下來
      - 保留／新增的鏡頭 = 好範例，刪掉的 = 壞範例 → 訓練一個小模型，之後挑片段時給好範例類型的片段加分
      - 你最後的時間軸長什麼樣（鏡頭多長、短鏡頭比例、縮放多大、用哪些效果）→ 更新「剪輯風格」
   2. 參考影片：分析別人剪好的影片，找出每個鏡頭的長度、是推近還是平移、轉場是直切／黑場／疊化、鏡頭怎麼排 → 也更新「剪輯風格」
   學的項目：
   - 選素材：保留／刪除哪種片段（小模型）、每支素材用幾個鏡頭、影片總長度、運鏡佔比
   - 順序：照拍攝順序的程度、靜止和運鏡怎麼接、用哪一種鏡頭開場
   - 轉場：同一支素材內、換素材、換場景時各用哪種轉場、多長
   - 畫面：鏡頭長短、短鏡頭比例、縮放幅度、推近／平移比例、常用的開頭、片尾、濾鏡
   你自己的修改影響比較大（權重 0.4），參考影片比較小（0.25）。
   學習資料存在這個瀏覽器裡，也可以匯出成檔案備份或帶到別台電腦。
*/
{
  const HC = window.HC;
  const KEY = "housingcut.profile.v1";
  const W_EDIT = 0.4, W_REF = 0.25;

  const fresh = () => ({
    v: 2, edits: 0, lastHash: "",
    style: { longStill: 5.5, shortStill: 2.6, rhythm: 0.4, zoom: 0.16, moveSpeed: 0.8, moveRatio: 0.45, maxMove: 14, len: 0, perClip: 0,
      modes: { in: 1, out: 1, panR: 1, panL: 1, panU: 0.1, panD: 0.1 },
      order: { n: 0, chrono: 1, firstS: 1, seq: { SS: 0.5, SM: 0.5, MS: 0.5, MM: 0.5 } },
      tr: { same: { cut: 1 }, change: { cut: 1 }, gap: { black: 1 } }, trDur: {} },
    look: { opening: {}, ending: {}, filter: {}, fx: {} },
    refs: [], examples: [], w: null,
  });
  // 舊版學習資料補上新欄位
  const upgrade = (o) => {
    const f = fresh();
    const out = Object.assign(f, o, { v: 2 });
    out.style = Object.assign(fresh().style, o.style || {});
    for (const k of ["order", "tr"]) out.style[k] = Object.assign(fresh().style[k], (o.style || {})[k] || {});
    out.look = Object.assign(fresh().look, o.look || {});
    if (o.style && o.style.dipRatio > 0.05 && !(o.style.tr)) out.style.tr.change = { cut: 1 - o.style.dipRatio, black: o.style.dipRatio };
    return out;
  };
  HC.profile = fresh();
  try { const j = localStorage.getItem(KEY); if (j) HC.profile = upgrade(JSON.parse(j)); } catch (e) {}
  HC.saveProfile = () => { try { localStorage.setItem(KEY, JSON.stringify(HC.profile)); } catch (e) {} };
  HC.resetProfile = () => { HC.profile = fresh(); HC.saveProfile(); };
  HC.hasLearned = () => HC.profile.edits > 0 || HC.profile.refs.length > 0;
  HC.importProfile = (o) => { if (!o || !o.style) throw new Error("bad"); HC.profile = upgrade(o); HC.saveProfile(); };

  /* ---------- 片段特徵 ---------- */
  HC.features = (clipId, a, b, isMove) => {
    const c = HC.clip(clipId), A = c && c.ana;
    if (!A) return null;
    let sp = 0, jit = 0, m = 0, lu = 0, n = 0, sx = 0, sy = 0, pos = 0, neg = 0;
    for (let i = 0; i < A.t.length; i++) if (A.t[i] >= a && A.t[i] <= b) { sx += A.dx[i]; sy += A.dy[i]; n++; }
    if (!n) return null;
    sx /= n; sy /= n;
    for (let i = 0; i < A.t.length; i++) if (A.t[i] >= a && A.t[i] <= b) {
      sp += Math.hypot(A.dx[i], A.dy[i]); jit += Math.abs(A.dx[i] - sx) + Math.abs(A.dy[i] - sy); m += A.m[i]; lu += A.luma[i];
      if (A.dx[i] > 2) pos++; if (A.dx[i] < -2) neg++;
    }
    const lateral = Math.abs(sx) > 1.8 * Math.abs(sy) && Math.abs(sx) > 5 && Math.max(pos, neg) / n > 0.7 ? 1 : 0;
    return [isMove ? 1 : 0, Math.min(b - a, 15) / 15, sp / n / 50, jit / n / 30, m / n / 20, lateral, lu / n / 255, a / (c.dur || 1)];
  };

  /* ---------- 小模型：邏輯迴歸 ---------- */
  const sig = (z) => 1 / (1 + Math.exp(-z));
  function train() {
    const ex = HC.profile.examples;
    const pos = ex.filter((e) => e.y === 1).length;
    if (ex.length < 8 || pos === 0 || pos === ex.length) { HC.profile.w = null; return; }
    const d = ex[0].f.length;
    let w = new Array(d + 1).fill(0);
    for (let ep = 0; ep < 400; ep++) for (const e of ex) {
      const p = sig(w[d] + e.f.reduce((s, v, k) => s + v * w[k], 0));
      const g = p - e.y;
      for (let k = 0; k < d; k++) w[k] -= 0.08 * (g * e.f[k] + 0.01 * w[k]);
      w[d] -= 0.08 * g;
    }
    HC.profile.w = w;
  }
  HC.predict = (f) => {
    const w = HC.profile.w;
    if (!w || !f) return null;
    return sig(w[w.length - 1] + f.reduce((s, v, k) => s + v * w[k], 0));
  };

  /* ---------- 從時間軸統計風格 ---------- */
  const median = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  function styleOf(shots) {
    if (shots.length < 3) return null;
    const out = (s) => s.dur / s.speed;
    const stills = shots.filter((s) => s.mode !== "move"), moves = shots.filter((s) => s.mode === "move");
    const total = HC.timeline().total;   // 扣掉轉場重疊的實際長度
    const longs = stills.map(out).filter((d) => d >= 4), shorts = stills.map(out).filter((d) => d < 4);
    const modes = { in: 0, out: 0, panR: 0, panL: 0, panU: 0, panD: 0 };
    for (const s of stills) if (s.mode in modes) modes[s.mode]++;
    const zs = stills.map((s) => s.zoom).filter((z) => z > 0);
    return {
      longStill: median(longs), shortStill: median(shorts),
      rhythm: stills.length ? shorts.length / stills.length : null,
      zoom: zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null,
      moveSpeed: median(moves.map((s) => s.speed)),
      moveRatio: total ? moves.reduce((t, s) => t + out(s), 0) / total : null,
      maxMove: moves.length ? HC.clamp(Math.max(...moves.map((s) => s.dur)), 4, 20) : null,
      modes: stills.length ? modes : null,
      len: total,
      perClip: shots.length / new Set(shots.map((s) => s.clipId)).size,
      ...orderOf(shots.map((s) => [s.mode === "move" ? "M" : "S", (HC.clip(s.clipId) || {}).time || 0, s.start])),
      ...trOf(shots),
    };
  }
  /* 順序：照拍攝時間的比例、靜止／運鏡怎麼接、開場鏡頭類型。items = [[類型, 拍攝時間, 起點]] */
  function orderOf(items) {
    if (items.length < 3) return {};
    let inOrder = 0;
    const cnt = { SS: 0, SM: 0, MS: 0, MM: 0 };
    for (let i = 1; i < items.length; i++) {
      const [pt, ptime, pst] = items[i - 1], [ct, ctime, cst] = items[i];
      if (ctime > ptime || (ctime === ptime && cst >= pst)) inOrder++;
      cnt[pt + ct]++;
    }
    const seq = {};
    for (const a of ["S", "M"]) { const n = cnt[a + "S"] + cnt[a + "M"]; if (n) { seq[a + "S"] = cnt[a + "S"] / n; seq[a + "M"] = cnt[a + "M"] / n; } }
    return { order: { chrono: inOrder / (items.length - 1), firstS: items[0][0] === "S" ? 1 : 0, seq } };
  }
  /* 轉場：每種情境用了哪些轉場、平均多長 */
  function trOf(shots) {
    const tr = { same: {}, change: {}, gap: {} }, durs = {};
    for (let i = 1; i < shots.length; i++) {
      const t = (shots[i].tr && shots[i].tr.type) || "cut", kind = HC.boundaryKind(shots[i - 1], shots[i]);
      tr[kind][t] = (tr[kind][t] || 0) + 1;
      if (t !== "cut") (durs[t] = durs[t] || []).push(shots[i].tr.dur);
    }
    const trDur = {};
    for (const [t, a] of Object.entries(durs)) trDur[t] = a.reduce((x, y) => x + y, 0) / a.length;
    for (const k of Object.keys(tr)) if (!Object.keys(tr[k]).length) delete tr[k];
    return { tr, trDur };
  }
  // 兩個比例分布混合（例如效果比例、轉場比例）
  function mixDist(cur, v, a) {
    const keys = new Set([...Object.keys(cur), ...Object.keys(v)]);
    const sum = Object.values(v).reduce((x, y) => x + y, 0) || 1, csum = Object.values(cur).reduce((x, y) => x + y, 0) || 1;
    for (const m of keys) cur[m] = ((cur[m] || 0) / csum) * (1 - a) + ((v[m] || 0) / sum) * a;
  }
  function blend(obs, a) {
    const st = HC.profile.style;
    for (const k of Object.keys(obs)) {
      const v = obs[k];
      if (v == null) continue;
      if (k === "modes") mixDist(st.modes, v, a);
      else if (k === "tr") for (const kind of Object.keys(v)) { st.tr[kind] = st.tr[kind] || {}; mixDist(st.tr[kind], v[kind], a); }
      else if (k === "trDur") for (const [t, d] of Object.entries(v)) st.trDur[t] = st.trDur[t] ? st.trDur[t] * (1 - a) + d * a : d;
      else if (k === "order") {
        const o = st.order;
        o.chrono = o.n ? o.chrono * (1 - a) + v.chrono * a : v.chrono;
        o.firstS = o.n ? o.firstS * (1 - a) + v.firstS * a : v.firstS;
        for (const [q, p] of Object.entries(v.seq || {})) o.seq[q] = o.n ? o.seq[q] * (1 - a) + p * a : p;
        o.n++;
      } else if (k === "len" || k === "perClip") st[k] = st[k] ? st[k] * (1 - a) + v * a : v;
      else st[k] = st[k] * (1 - a) + v * a;
    }
  }
  // 你選的開頭、片尾、濾鏡、特效：記次數，下次開新專案時預先選好最常用的
  function countLook() {
    const L = HC.profile.look, S = HC.state, inc = (m, k) => { m[k] = (m[k] || 0) + 1; };
    inc(L.opening, S.title.template);
    inc(L.ending, S.ending.template);
    inc(L.filter, S.look.filter);
  }
  HC.topOf = (m) => Object.entries(m || {}).sort((a, b) => b[1] - a[1])[0];

  /* ---------- 從手動修改學習 ---------- */
  HC.markAuto = () => {
    HC.lastAuto = HC.state.shots.map((s) => ({ ...s, f: HC.features(s.clipId, s.start, s.start + s.dur, s.mode === "move") }));
  };
  HC.timelineHash = () => JSON.stringify(HC.state.shots.map((s) => [s.clipId, s.start, s.dur, s.mode, s.zoom, s.speed, s.tr && s.tr.type]));
  HC.learnFromEdits = () => {
    const P = HC.profile, shots = HC.state.shots, auto = HC.lastAuto || [];
    const h = HC.timelineHash();
    if (h === P.lastHash) return { ok: false, why: "這版已經學過了" };
    const autoHash = JSON.stringify(auto.map((s) => [s.clipId, s.start, s.dur, s.mode, s.zoom, s.speed, s.tr && s.tr.type]));
    if (auto.length && h === autoHash) return { ok: false, why: "時間軸跟自動剪輯的結果一樣，沒有修改可以學" };
    const ov = (x, y) => x.clipId === y.clipId && Math.min(x.start + x.dur, y.start + y.dur) - Math.max(x.start, y.start) > 0.5 * Math.min(x.dur, y.dur);
    let kept = 0, del = 0, add = 0;
    for (const a of auto) {
      if (!a.f) continue;
      const k = shots.some((s) => ov(s, a));
      P.examples.push({ f: a.f, y: k ? 1 : 0 }); k ? kept++ : del++;
    }
    for (const s of shots) if (!auto.some((a) => ov(s, a))) {
      const f = HC.features(s.clipId, s.start, s.start + s.dur, s.mode === "move");
      if (f) { P.examples.push({ f, y: 1 }); add++; }
    }
    if (P.examples.length > 600) P.examples = P.examples.slice(-600);
    const obs = styleOf(shots);
    if (obs) blend(obs, W_EDIT);
    countLook();
    P.edits++; P.lastHash = h;
    train(); HC.saveProfile();
    return { ok: true, kept, del, add };
  };

  /* ---------- 參考影片 ---------- */
  HC.analyzeReference = async (file, onProgress) => {
    const url = URL.createObjectURL(file);
    const c = { id: "ref", url };
    const A = await HC.analyzeClip(c, onProgress, { zoom: true, ref: true });
    URL.revokeObjectURL(url);
    const n = A.t.length, med = (i) => { const w = A.m.slice(Math.max(0, i - 6), i + 7).sort((x, y) => x - y); return w[w.length >> 1]; };
    // 切點：畫面突然大變；黑場：亮度很低的一段
    const cuts = [], dips = [];
    let inBlack = -1;
    for (let i = 0; i < n; i++) {
      const dark = A.luma[i] < 10;
      if (dark && inBlack < 0) inBlack = i;
      if (!dark && inBlack >= 0) { dips.push((A.t[inBlack] + A.t[i - 1]) / 2); inBlack = -1; }
      if (!dark && A.m[i] > Math.max(14, 5 * med(i))) cuts.push(A.t[i] - 0.05);
    }
    // 疊化（溶接）：沒有黑場、也不是一格就切換，而是 0.4～1.5 秒內畫面慢慢換掉，且不是鏡頭在平移
    const fades = [];
    const k6 = Math.max(3, Math.round(6 * n / Math.max(1, c.dur) / 10));
    for (let i = k6; i < n - k6; i++) {
      let sum = 0, mx = 0, sx = 0, sy = 0;
      for (let j = i - k6; j < i + k6; j++) { sum += A.m[j]; mx = Math.max(mx, A.m[j]); sx += A.dx[j]; sy += A.dy[j]; }
      if (!(sum > 40 && mx < sum * 0.35 && Math.hypot(sx, sy) / (2 * k6) < 3 && A.luma[i] >= 10)) continue;
      const t = A.t[i];
      if (!cuts.some((x) => Math.abs(x - t) < 1.5) && !dips.some((x) => Math.abs(x - t) < 1.5) && !fades.some((x) => Math.abs(x - t) < 1.5)) fades.push(t);
    }
    const bounds = [0, ...cuts, ...dips, ...fades, c.dur].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.5);
    const shots = [];
    for (let k = 0; k < bounds.length - 1; k++) {
      const a = bounds[k], b = bounds[k + 1], idx = [];
      for (let i = 0; i < n; i++) if (A.t[i] > a + 0.2 && A.t[i] < b - 0.2 && A.luma[i] >= 10) idx.push(i);
      if (b - a < 0.6 || idx.length < 2) continue;
      const mean = (arr) => idx.reduce((s, i) => s + arr[i], 0) / idx.length;
      const m = mean(A.m), dx = mean(A.dx), dy = mean(A.dy), zm = mean(A.zm);
      const jit = idx.reduce((s, i) => s + Math.abs(A.dx[i] - dx) + Math.abs(A.dy[i] - dy), 0) / idx.length;
      let kind = "move";
      if (Math.abs(zm) > 0.008 && Math.abs(zm) * 60 > Math.hypot(dx, dy)) kind = zm > 0 ? "in" : "out";
      else if (Math.hypot(dx, dy) > 2 && jit < 6) kind = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "panR" : "panL") : (dy < 0 ? "panD" : "panU");
      else if (m < 1.5) kind = "still";
      const trBefore = dips.some((t) => Math.abs(t - a) < 0.8) ? "black" : fades.some((t) => Math.abs(t - a) < 0.8) ? "fade" : "cut";
      shots.push({ a, b, d: b - a, kind, zoomAmt: Math.abs(zm) * (b - a), trBefore });
    }
    if (shots.length < 3) throw new Error("找不到足夠的鏡頭切換");
    const fx = shots.filter((s) => s.kind !== "move"), mv = shots.filter((s) => s.kind === "move");
    const total = shots.reduce((t, s) => t + s.d, 0);
    const modes = { in: 0, out: 0, panR: 0, panL: 0, panU: 0, panD: 0 };
    for (const s of fx) if (s.kind in modes) modes[s.kind]++;
    const zooms = fx.filter((s) => s.kind === "in" || s.kind === "out").map((s) => s.zoomAmt);
    const obs = {
      longStill: median(fx.map((s) => s.d).filter((d) => d >= 4)),
      shortStill: median(fx.map((s) => s.d).filter((d) => d < 4)),
      rhythm: fx.length ? fx.filter((s) => s.d < 4).length / fx.length : null,
      zoom: zooms.length ? HC.clamp(median(zooms), 0.04, 0.3) : null,
      moveRatio: total ? mv.reduce((t, s) => t + s.d, 0) / total : null,
      modes: Object.values(modes).some((v) => v) ? modes : null,
      len: c.dur,
      ...orderOf(shots.map((s, i) => [s.kind === "move" ? "M" : "S", 0, i])),
    };
    obs.order && (obs.order.chrono = HC.profile.style.order.chrono);   // 參考影片看不出原始拍攝順序，順序只學「靜止／運鏡怎麼接」
    const trc = {};
    for (const s of shots.slice(1)) trc[s.trBefore] = (trc[s.trBefore] || 0) + 1;
    obs.tr = { change: trc };
    if (trc.black) obs.tr.gap = { black: trc.black };
    obs.trDur = {};
    if (trc.black) obs.trDur.black = 1.2;
    if (trc.fade) obs.trDur.fade = 1.0;
    blend(obs, W_REF);
    const summary = { name: file.name, dur: c.dur, shots: shots.length, avg: total / shots.length, dips: (trc.black || 0) / (shots.length - 1), fades: (trc.fade || 0) / (shots.length - 1), moveRatio: obs.moveRatio, zoom: obs.zoom, modes };
    HC.profile.refs.push(summary);
    HC.saveProfile();
    return summary;
  };
  HC.removeReference = (i) => { HC.profile.refs.splice(i, 1); HC.saveProfile(); };
}
