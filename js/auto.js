/* 自動剪輯
   1. 把每支素材分成「靜止」「運鏡」「太快／晃動／有鼠標」三種時段
   2. 靜止時段 → 加推近、拉遠或平移效果；運鏡時段 → 保留原本的鏡頭移動
   3. 先讓每支素材至少有一個鏡頭（涵蓋所有場景），再依分數補到目標長度
   4. 長鏡頭之間穿插短鏡頭做出節奏，再決定順序（照拍攝時間或依學到的接法）和轉場
*/
{
  const HC = window.HC;

  /* 可調整的判斷門檻（數值來自實測 FF14 1080p 錄影） */
  HC.TUNE = {
    still: 1.5,        // 畫面變化量低於這個值 = 靜止
    fastBase: 45,      // 鏡頭移動速度上限（小圖每秒像素），乘上晃動容忍度
    jitterBase: 22,    // 晃動程度上限
    minStill: 2.0,     // 靜止片段至少幾秒才採用
    minMove: 1.8,      // 運鏡片段至少幾秒才採用
    maxMove: 14,       // 一個運鏡鏡頭最長幾秒（原始素材秒數）
    longStill: 5.5,    // 長的靜止鏡頭（成品秒數）
    shortStill: 2.6,   // 短的靜止鏡頭
  };

  HC.TUNE_DEFAULT = { ...HC.TUNE };

  /* 把一支素材的分析結果切成時段 */
  HC.segmentClip = (clip, opt) => {
    const A = clip.ana, T = HC.TUNE;
    if (!A || A.t.length < 4) return [];
    const n = A.t.length;
    const rate = n / Math.max(0.5, A.t[n - 1] - A.t[0]);
    const k = Math.max(1, Math.round(rate * 0.4));
    const tol = 0.6 + opt.tol * 0.8;        // 0.6 ~ 1.4
    const avg = (arr, i, kk) => { let s = 0, c = 0; for (let j = Math.max(0, i - kk); j <= Math.min(n - 1, i + kk); j++) { s += arr[j]; c++; } return s / c; };
    const ex = (clip.excluded || []);
    const cls = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = A.t[i];
      const m = avg(A.m, i, Math.max(1, k >> 1));
      const mdx = avg(A.dx, i, k), mdy = avg(A.dy, i, k);
      const sp = Math.hypot(mdx, mdy);
      let jit = 0, c = 0;
      for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) { jit += Math.abs(A.dx[j] - mdx) + Math.abs(A.dy[j] - mdy); c++; }
      jit /= c;
      // 不能用的原因：X 開頭結尾／太暗、C 鼠標、U 遊戲介面、E 你標記排除
      let bad = t < opt.head || t > clip.dur - 0.3 || A.luma[i] < 12 ? "X" : "";
      if (opt.cursor) for (const [a, b] of A.cursor) if (t >= a && t <= b) bad = "C";
      if (opt.ui && A.ui) for (const [a, b] of A.ui) if (t >= a && t <= b) bad = "U";
      for (const [a, b] of ex) if (t >= a && t <= b) bad = "E";
      if (bad) cls[i] = bad;
      else if (m < T.still && sp < 6) cls[i] = "S";
      else if (sp > T.fastBase * tol || jit > T.jitterBase * tol) cls[i] = "F";
      else cls[i] = "M";
    }
    // 單一個「太快」取樣通常是雜訊，視為運鏡
    for (let i = 1; i < n - 1; i++) if (cls[i] === "F" && cls[i - 1] === "M" && cls[i + 1] === "M") cls[i] = "M";
    // 運鏡中間很短的停頓，不要切斷
    const runs = [];
    for (let i = 0; i < n; i++) {
      if (runs.length && runs[runs.length - 1].c === cls[i]) runs[runs.length - 1].j = i;
      else runs.push({ c: cls[i], i, j: i });
    }
    for (let r = 1; r < runs.length - 1; r++) {
      const R = runs[r];
      if (R.c === "S" && runs[r - 1].c === "M" && runs[r + 1].c === "M" && A.t[R.j] - A.t[R.i] < 0.6) R.c = "M";
    }
    const merged = [];
    for (const R of runs) {
      if (merged.length && merged[merged.length - 1].c === R.c) merged[merged.length - 1].j = R.j;
      else merged.push({ ...R });
    }
    const out = [];
    for (const R of merged) {
      const a = A.t[R.i], b = A.t[R.j], L = b - a;
      if (R.c === "S" && L >= T.minStill) {
        if (L > 12) { out.push(still(a, a + 6)); out.push(still(b - 6, b)); }
        else out.push(still(a, b));
      }
      if (R.c === "M" && L >= T.minMove) {
        const parts = Math.ceil(L / T.maxMove);
        const pl = L / parts;
        for (let p = 0; p < parts; p++) {
          const pa = a + p * pl + (p ? 0.25 : 0), pb = a + (p + 1) * pl - (p < parts - 1 ? 0.25 : 0);
          out.push(move(pa, pb));
        }
      }
    }
    function still(a, b) { return { clipId: clip.id, type: "S", a, b, score: Math.min(b - a, 6) * 0.8 }; }
    function move(a, b) {
      let sx = 0, sy = 0, c = 0, pos = 0, neg = 0, jit = 0;
      for (let i = 0; i < n; i++) if (A.t[i] >= a && A.t[i] <= b) { sx += A.dx[i]; sy += A.dy[i]; c++; if (A.dx[i] > 2) pos++; if (A.dx[i] < -2) neg++; }
      sx /= c || 1; sy /= c || 1;
      for (let i = 0; i < n; i++) if (A.t[i] >= a && A.t[i] <= b) jit += Math.abs(A.dx[i] - sx) + Math.abs(A.dy[i] - sy);
      jit /= c || 1;
      const lateral = Math.abs(sx) > 1.8 * Math.abs(sy) && Math.abs(sx) > 5 && Math.max(pos, neg) / Math.max(1, c) > 0.7;
      const smooth = 1 / (1 + jit / 12);
      return { clipId: clip.id, type: "M", a, b, lateral, smooth, score: Math.min(b - a, 12) * smooth * (lateral && opt.lateral ? 1.5 : 1) };
    }
    clip.segs = out;
    clip.cls = { t: A.t, c: cls };
    return out;
  };

  HC.sortClips = () => {
    HC.state.clips.sort((x, y) => (x.time - y.time) || x.name.localeCompare(y.name, undefined, { numeric: true }));
  };

  HC.autoEdit = () => {
    const S = HC.state, opt = S.auto, T = HC.TUNE;
    // 套用學到的風格：把學到的數值填進設定（介面上的滑桿也會跟著變）
    // 還沒學過任何東西時不覆蓋你調的滑桿（預設風格和滑桿預設值一樣，套了沒意義）
    const L = opt.learn && HC.hasLearned && HC.hasLearned() ? HC.profile.style : null;
    if (!L) Object.assign(T, HC.TUNE_DEFAULT);
    if (L) {
      T.longStill = +HC.clamp(L.longStill, 3, 12).toFixed(1); T.shortStill = +HC.clamp(L.shortStill, 1.5, 4).toFixed(1); T.maxMove = Math.round(HC.clamp(L.maxMove, 4, 20));
      opt.rhythm = +HC.clamp(L.rhythm, 0, 1).toFixed(2); opt.zoom = +HC.clamp(L.zoom, 0.04, 0.3).toFixed(2);
      opt.speed = [0.6, 0.8, 1].reduce((b, v) => Math.abs(v - L.moveSpeed) < Math.abs(b - L.moveSpeed) ? v : b, 0.8);
      if (L.len) opt.len = Math.round(HC.clamp(L.len, 30, 300) / 5) * 5;
    }
    HC.sortClips();
    HC.computeScenes();
    const clips = S.clips.filter((c) => c.ana);
    const order = new Map(clips.map((c, i) => [c.id, i]));
    let cands = [];
    for (const c of clips) cands = cands.concat(HC.segmentClip(c, opt));
    // 依學到的偏好調整分數：運鏡／靜止的比例，以及「你通常會留下哪種片段」
    if (L) {
      const fMove = HC.clamp(L.moveRatio / 0.45, 0.4, 2.2);
      for (const x of cands) {
        if (x.type === "M") x.score *= fMove;
        const p = HC.predict(HC.features(x.clipId, x.a, x.b, x.type === "M"));
        if (p != null) { x.p = p; x.score *= 0.4 + 1.2 * p; }
      }
    }
    const nominal = (x) => x.type === "S" ? T.longStill * (1 - opt.rhythm * 0.45) : Math.min(x.b - x.a, T.maxMove) / opt.speed;
    const picked = [];
    const clash = (x) => picked.some((p) => p.clipId === x.clipId && x.a < p.b + 0.8 && x.b > p.a - 0.8);
    let total = 0;
    if (opt.cover) {
      for (const c of clips) {
        const mine = cands.filter((x) => x.clipId === c.id).sort((p, q) => q.score - p.score);
        if (mine.length) { picked.push(mine[0]); total += nominal(mine[0]); }
      }
    }
    // 每支素材最多用幾個鏡頭（學到你通常一支素材用幾個）
    const cap = L && L.perClip ? Math.max(1, Math.ceil(L.perClip * 1.5)) : 99;
    const count = (id) => picked.filter((p) => p.clipId === id).length;
    for (const x of cands.slice().sort((p, q) => q.score - p.score)) {
      if (total >= opt.len) break;
      if (picked.includes(x) || clash(x) || count(x.clipId) >= cap) continue;
      picked.push(x); total += nominal(x);
    }
    picked.sort((p, q) => (order.get(p.clipId) - order.get(q.clipId)) || (p.a - q.a));

    // 效果輪流使用；有學習資料時，依你常用的效果比例分配
    const W = L ? L.modes : { in: 2, panR: 1, out: 2, panL: 1 };
    const used = {};
    const nextMode = () => {
      let best = "in", bs = -Infinity;
      const tot = Object.values(W).reduce((a, b) => a + b, 0) || 1, n = Object.values(used).reduce((a, b) => a + b, 0) + 1;
      for (const [m, w] of Object.entries(W)) { if (w <= 0.02) continue; const sc = (w / tot) * n - (used[m] || 0); if (sc > bs) { bs = sc; best = m; } }
      used[best] = (used[best] || 0) + 1;
      return best;
    };
    let acc = 0.5;
    const shots = [];
    picked.forEach((x, idx) => {
      if (x.type === "M") {
        const sh = mk(x.clipId, x.a, x.b - x.a, "move", 0, opt.speed);
        sh.stab = !!opt.stab; sh.stabStr = opt.stabStr;
        shots.push(sh);
        return;
      }
      let short = false;
      if (idx > 0) { acc += opt.rhythm; if (acc >= 1) { short = true; acc -= 1; } }
      const want = short ? T.shortStill : T.longStill;
      const len = Math.min(x.b - x.a, want);
      const a = x.a + (x.b - x.a - len) / 2;
      let mode = idx === 0 ? "in" : nextMode();
      shots.push(mk(x.clipId, a, len, mode, short ? Math.min(0.35, opt.zoom * 1.3) : opt.zoom, 1));
    });
    // 順序：照拍攝時間，或依學到的「靜止／運鏡」接法重新排（只在同一段場景內調整）
    const ordered = HC.orderShots(shots, opt, L);
    // 轉場：依學到的偏好、或你指定的轉場
    HC.assignTransitions(ordered, opt, L);
    S.shots = ordered;
    HC.markAuto && HC.markAuto();
    return ordered;

    function mk(clipId, start, dur, mode, zoom, speed) {
      return { id: HC.uid("s"), clipId, start: +start.toFixed(2), dur: +dur.toFixed(2), mode, zoom: +zoom.toFixed(2), speed, tr: { type: "cut", dur: 0 }, text: "", stab: false, stabStr: opt.stabStr };
    }
  };

  /* ---------- 場景 ----------
     依拍攝時間排好素材，以下任一情況就開始新場景：
     1. 和上一支的拍攝時間相隔超過設定的分鐘數
     2. 畫面明顯換了（例如庭園 → 室內）：比較「前 3 支」和「後 3 支」素材的平均色彩，差異是附近最大、且超過門檻
        （只比單一支會被夜景、特寫誤判，所以看前後一小段的平均）；每個場景至少 3 支素材
     3. 你在素材區手動標記的「從這裡開始新場景」／「併回上一個場景」優先
     結果存在每支素材的 c.scene（場景編號，從 0 開始） */
  HC.computeScenes = () => {
    const S = HC.state, opt = S.auto;
    const cs = S.clips.slice().sort((x, y) => (x.time - y.time) || x.name.localeCompare(y.name, undefined, { numeric: true }));
    const n = cs.length, brk = new Array(n).fill(false), why = new Array(n).fill("");
    for (let i = 1; i < n; i++) if (opt.gap > 0 && Math.abs(cs[i].time - cs[i - 1].time) > opt.gap * 60000) { brk[i] = true; why[i] = "time"; }
    if (opt.sceneLook > 0 && n >= 6) {
      const K = 3, thr = 0.4 - 0.25 * opt.sceneLook;   // 靈敏度 0～1 → 門檻 0.4～0.15
      const mean = (a, b) => {
        const xs = cs.slice(Math.max(0, a), Math.min(n, b)).map((c) => c.ana && c.ana.sig).filter(Boolean);
        if (!xs.length) return null;
        return xs[0].map((_, k) => xs.reduce((s, x) => s + x[k], 0) / xs.length);
      };
      const sc = new Array(n).fill(0);
      for (let i = 1; i < n; i++) { const a = mean(i - K, i), b = mean(i, i + K); sc[i] = a && b ? HC.sigDiff(a, b) : 0; }
      const cands = [];
      for (let i = 1; i < n; i++) if (sc[i] > thr && sc[i] >= Math.max(sc[i - 1] || 0, sc[i + 1] || 0, sc[i - 2] || 0, sc[i + 2] || 0)) cands.push(i);
      cands.sort((a, b) => sc[b] - sc[a]);
      for (const i of cands) {
        if (brk[i]) continue;
        let p = i - 1; while (p > 0 && !brk[p]) p--;
        let q = i + 1; while (q < n && !brk[q]) q++;
        if (i - p >= 3 && q - i >= 3) { brk[i] = true; why[i] = "look"; }
      }
    }
    for (let i = 0; i < n; i++) {
      if (cs[i].sceneMark === "start" && i) { brk[i] = true; why[i] = "mark"; }
      if (cs[i].sceneMark === "join") { brk[i] = false; why[i] = ""; }
    }
    let k = 0;
    cs.forEach((c, i) => { if (i && brk[i]) k++; c.scene = k; c.sceneWhy = brk[i] ? why[i] : ""; });
    return k + 1;
  };
  const sceneOf = (clipId) => { const c = HC.clip(clipId); return c && c.scene != null ? c.scene : 0; };

  /* ---------- 順序 ---------- */
  const scenes = (shots) => {
    const out = [];
    for (const s of shots) {
      const last = out[out.length - 1];
      if (!last || sceneOf(s.clipId) !== sceneOf(last[last.length - 1].clipId)) out.push([s]); else last.push(s);
    }
    return out;
  };
  HC.orderShots = (shots, opt, L) => {
    const mode = opt.order === "learn" ? (L && L.order && L.order.n ? (L.order.chrono >= 0.7 ? "time" : "seq") : "time") : opt.order;
    if (mode === "time" || shots.length < 3) return shots;
    const seq = mode === "seq" ? L.order.seq : { SS: 0.2, SM: 0.8, MS: 0.8, MM: 0.2 };
    const type = (s) => (s.mode === "move" ? "M" : "S");
    const out = [];
    scenes(shots).forEach((sc, k) => {
      const rest = sc.slice();
      let first = rest[0];
      if (k === 0 && mode === "seq") {   // 開場鏡頭的類型：學你習慣用靜止還是運鏡開場
        const want = L.order.firstS >= 0.5 ? "S" : "M";
        first = rest.find((s) => type(s) === want) || rest[0];
      }
      out.push(first); rest.splice(rest.indexOf(first), 1);
      while (rest.length) {
        const prev = type(out[out.length - 1]);
        const want = (seq[prev + "S"] || 0) >= (seq[prev + "M"] || 0) ? "S" : "M";
        const nx = rest.find((s) => type(s) === want) || rest[0];   // 同類型裡挑拍攝時間最早的，盡量保持動線
        out.push(nx); rest.splice(rest.indexOf(nx), 1);
      }
    });
    return out;
  };

  /* ---------- 轉場 ---------- */
  // 每個接點的情境：同一支素材、換素材、換場景（拍攝時間相隔很久）
  HC.boundaryKind = (prev, cur) => {
    if (prev.clipId === cur.clipId) return "same";
    return sceneOf(prev.clipId) !== sceneOf(cur.clipId) ? "gap" : "change";
  };
  HC.assignTransitions = (shots, opt, L) => {
    const mix = ["fade", "blur", "circle", "wipeR", "zoom", "slow"];
    let mi = 0;
    const used = { same: {}, change: {}, gap: {} };
    const pick = (kind) => {   // 依比例輪流分配（和效果分配同一種做法，結果可重現）
      const w = L.tr[kind] || {};
      const tot = Object.values(w).reduce((a, b) => a + b, 0);
      if (!tot) return kind === "gap" ? "black" : "cut";
      const n = Object.values(used[kind]).reduce((a, b) => a + b, 0) + 1;
      let best = "cut", bs = -Infinity;
      for (const [t, v] of Object.entries(w)) { const sc = (v / tot) * n - (used[kind][t] || 0); if (sc > bs) { bs = sc; best = t; } }
      used[kind][best] = (used[kind][best] || 0) + 1;
      return best;
    };
    shots.forEach((s, i) => {
      if (!i) { s.tr = { type: "cut", dur: 0 }; return; }
      const kind = HC.boundaryKind(shots[i - 1], s);
      let type;
      if (opt.trMode === "all") type = opt.trType;
      else if (opt.trMode === "mix") type = kind === "same" ? "cut" : kind === "gap" ? "black" : mix[mi++ % mix.length];
      else if (opt.trMode === "learn" && L && L.tr) type = pick(kind);
      else type = kind === "gap" ? "black" : "cut";
      const d = L && L.trDur && L.trDur[type] ? L.trDur[type] : HC.trInfo(type).dur;
      s.tr = { type, dur: +d.toFixed(2) };
    });
  };
}
