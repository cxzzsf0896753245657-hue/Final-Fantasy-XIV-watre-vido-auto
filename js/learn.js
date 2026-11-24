/* 學習
   兩個來源：
   1. 你的手動修改：自動剪輯後你刪掉、加入、改長度、換效果的鏡頭，都會被記下來
      - 保留／新增的鏡頭 = 好範例，刪掉的 = 壞範例 → 訓練一個小模型，之後挑片段時給好範例類型的片段加分
      - 你最後的時間軸長什麼樣（鏡頭多長、短鏡頭比例、縮放多大、用哪些效果）→ 更新「剪輯風格」
   2. 參考影片：分析別人剪好的影片，找出每個鏡頭的長度、是推近還是平移、轉場有沒有黑場 → 也更新「剪輯風格」
   你自己的修改影響比較大（權重 0.4），參考影片比較小（0.25）。
   學習資料存在這個瀏覽器裡，也可以匯出成檔案備份或帶到別台電腦。
*/
{
  const HC = window.HC;
  const KEY = "housingcut.profile.v1";
  const W_EDIT = 0.4, W_REF = 0.25;

  const fresh = () => ({
    v: 1, edits: 0, lastHash: "",
    style: { longStill: 5.5, shortStill: 2.6, rhythm: 0.4, zoom: 0.16, moveSpeed: 0.8, moveRatio: 0.45, maxMove: 14, dipRatio: 0,
      modes: { in: 1, out: 1, panR: 1, panL: 1, panU: 0.1, panD: 0.1 } },
    refs: [], examples: [], w: null,
  });
  HC.profile = fresh();
  try { const j = localStorage.getItem(KEY); if (j) HC.profile = Object.assign(fresh(), JSON.parse(j)); } catch (e) {}
  HC.saveProfile = () => { try { localStorage.setItem(KEY, JSON.stringify(HC.profile)); } catch (e) {} };
  HC.resetProfile = () => { HC.profile = fresh(); HC.saveProfile(); };
  HC.importProfile = (o) => { if (!o || o.v !== 1 || !o.style) throw new Error("bad"); HC.profile = Object.assign(fresh(), o); HC.saveProfile(); };

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
    const total = shots.reduce((t, s) => t + out(s), 0);
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
      dipRatio: shots.slice(1).filter((s) => s.dip).length / (shots.length - 1),
      modes: stills.length ? modes : null,
    };
  }
  function blend(obs, a) {
    const st = HC.profile.style;
    for (const k of Object.keys(obs)) {
      const v = obs[k];
      if (v == null) continue;
      if (k === "modes") {
        const sum = Object.values(v).reduce((x, y) => x + y, 0) || 1, cur = st.modes, csum = Object.values(cur).reduce((x, y) => x + y, 0) || 1;
        for (const m of Object.keys(cur)) cur[m] = (cur[m] / csum) * (1 - a) + ((v[m] || 0) / sum) * a;
      } else st[k] = st[k] * (1 - a) + v * a;
    }
  }

  /* ---------- 從手動修改學習 ---------- */
  HC.markAuto = () => {
    HC.lastAuto = HC.state.shots.map((s) => ({ ...s, f: HC.features(s.clipId, s.start, s.start + s.dur, s.mode === "move") }));
  };
  HC.timelineHash = () => JSON.stringify(HC.state.shots.map((s) => [s.clipId, s.start, s.dur, s.mode, s.zoom, s.speed, s.dip]));
  HC.learnFromEdits = () => {
    const P = HC.profile, shots = HC.state.shots, auto = HC.lastAuto || [];
    const h = HC.timelineHash();
    if (h === P.lastHash) return { ok: false, why: "這版已經學過了" };
    const autoHash = JSON.stringify(auto.map((s) => [s.clipId, s.start, s.dur, s.mode, s.zoom, s.speed, s.dip]));
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
    P.edits++; P.lastHash = h;
    train(); HC.saveProfile();
    return { ok: true, kept, del, add };
  };

  /* ---------- 參考影片 ---------- */
  HC.analyzeReference = async (file, onProgress) => {
    const url = URL.createObjectURL(file);
    const c = { id: "ref", url };
    const A = await HC.analyzeClip(c, onProgress, { zoom: true });
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
    const bounds = [0, ...cuts, ...dips, c.dur].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.5);
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
      shots.push({ a, b, d: b - a, kind, zoomAmt: Math.abs(zm) * (b - a), dipBefore: dips.some((t) => Math.abs(t - a) < 0.8) });
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
      dipRatio: shots.slice(1).filter((s) => s.dipBefore).length / (shots.length - 1),
      modes: Object.values(modes).some((v) => v) ? modes : null,
    };
    blend(obs, W_REF);
    const summary = { name: file.name, dur: c.dur, shots: shots.length, avg: total / shots.length, dips: obs.dipRatio, moveRatio: obs.moveRatio, zoom: obs.zoom, modes };
    HC.profile.refs.push(summary);
    HC.saveProfile();
    return summary;
  };
  HC.removeReference = (i) => { HC.profile.refs.splice(i, 1); HC.saveProfile(); };
}
