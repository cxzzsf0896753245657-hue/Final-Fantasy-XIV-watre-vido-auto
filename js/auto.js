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

  /* over：這次剪輯用的額外設定（做「好幾個版本」時用），不會改到你的設定
     dry：只產生鏡頭、不放進時間軸 */
  HC.autoEdit = (over, dry) => {
    const S = HC.state, opt = { ...S.auto }, T = HC.TUNE;
    // 套用學到的風格：把學到的數值填進設定（介面上的滑桿也會跟著變）
    // 還沒學過任何東西時不覆蓋你調的滑桿（預設風格和滑桿預設值一樣，套了沒意義）
    const L = opt.learn && HC.hasLearned && HC.hasLearned() ? HC.profile.style : null;
    if (!L) Object.assign(T, HC.TUNE_DEFAULT);
    if (L) {
      T.longStill = +HC.clamp(L.longStill, 3, 12).toFixed(1); T.shortStill = +HC.clamp(L.shortStill, 1.5, 4).toFixed(1); T.maxMove = Math.round(HC.clamp(L.maxMove, 4, 20));
      opt.rhythm = +HC.clamp(L.rhythm, 0, 1).toFixed(2); opt.zoom = +HC.clamp(L.zoom, 0.04, 0.3).toFixed(2);
      opt.speed = [0.6, 0.8, 1].reduce((b, v) => Math.abs(v - L.moveSpeed) < Math.abs(b - L.moveSpeed) ? v : b, 0.8);
      if (L.len && !opt.lenSet) opt.len = Math.round(HC.clamp(L.len, 30, 300) / 5) * 5;
      // 滑桿跟著學到的值走（只有真的套用到時間軸時）
      if (!dry) Object.assign(S.auto, { rhythm: opt.rhythm, zoom: opt.zoom, speed: opt.speed, len: opt.len });
    }
    // 目標長度：有背景音樂時，不要超過音樂能用的長度
    if (opt.fitMusic !== false && S.music.url && HC.R && HC.R.music.el.duration > 0) opt.len = Math.min(opt.len, Math.max(20, HC.R.music.el.duration - (S.music.off || 0)));
    if (over) { Object.assign(opt, over); if (over.T) Object.assign(T, over.T); }
    HC.sortClips();
    HC.computeScenes();
    const clips = S.clips.filter((c) => c.ana);
    const order = new Map(clips.map((c, i) => [c.id, i]));
    let cands = [];
    for (const c of clips) cands = cands.concat(HC.segmentClip(c, opt));
    // 依學到的偏好調整分數：運鏡／靜止的比例（依場景類型），以及「你通常會留下哪種片段」
    if (L) {
      for (const x of cands) {
        const Lt = HC.styleFor(HC.clipType(x.clipId));
        if (x.type === "M") x.score *= HC.clamp(Lt.moveRatio / 0.45, 0.4, 2.2);
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
        if (mine.length) { mine[0].cover = true; picked.push(mine[0]); total += nominal(mine[0]); }
      }
    }
    // 每支素材最多用幾個鏡頭（學到你通常一支素材用幾個）
    const cap = L && L.perClip ? Math.max(1, Math.ceil(L.perClip * 1.5)) : 99;
    const count = (id) => picked.filter((p) => p.clipId === id).length;
    // 角度幾乎一樣的片段只留分數最高的一個（同一個角落拍了好幾次）
    const asShot = (x) => ({ clipId: x.clipId, start: x.a, dur: x.b - x.a });
    const dup = (x) => opt.dedupe !== false && x.type !== "M" && picked.some((p) => p.type !== "M" && p.clipId !== x.clipId && HC.shotSimilarity && HC.shotSimilarity(asShot(p), asShot(x)) > 0.85);
    let skipped = 0;
    for (const x of cands.slice().sort((p, q) => q.score - p.score)) {
      if (total >= opt.len) break;
      if (picked.includes(x) || clash(x) || count(x.clipId) >= cap) continue;
      if (dup(x)) { skipped++; continue; }
      picked.push(x); total += nominal(x);
    }
    HC.lastDedupe = skipped;
    picked.sort((p, q) => (order.get(p.clipId) - order.get(q.clipId)) || (p.a - q.a));

    // 效果：照你常用的比例輪流（可依場景類型），再看畫面內容調整（細節集中 → 推近、一邊細節多 → 平移）
    const used = {};
    const nextMode = (W, pref) => {
      let best = "in", bs = -Infinity;
      const tot = Object.values(W).reduce((a, b) => a + b, 0) || 1, n = Object.values(used).reduce((a, b) => a + b, 0) + 1;
      for (const [m, w] of Object.entries(W)) {
        if (w <= 0.02 && !(pref && pref[m] > 0.35)) continue;
        const sc = (w / tot) * n - (used[m] || 0) + (pref ? 1.2 * (pref[m] || 0) : 0);
        if (sc > bs) { bs = sc; best = m; }
      }
      used[best] = (used[best] || 0) + 1;
      return best;
    };
    const fine = L && HC.profile.fine && HC.profile.fine.n ? HC.profile.fine : null;
    const MN = { in: "推近", out: "拉遠", panR: "向右平移", panL: "向左平移", panU: "向上平移", panD: "向下平移" };
    let acc = 0.5;
    const shots = [];
    picked.forEach((x, idx) => {
      const type = HC.clipType(x.clipId), Lt = L ? HC.styleFor(type) : null, why = [];
      if (x.cover) why.push("這支素材分數最高的片段（每支素材至少用一個）");
      if (x.p != null && x.p >= 0.6) why.push(`跟你保留過的片段很像（${Math.round(x.p * 100)}%）`);
      if (x.p != null && x.p < 0.35) why.push("模型覺得普通，但素材不夠只好用");
      if (Lt && type && HC.profile.byType[type] && HC.profile.byType[type].n) why.push(`套用你的「${HC.SCENE_TYPES[type]}」風格`);
      if (x.type === "M") {
        let a = x.a, b = x.b;
        // 學到你習慣把運鏡頭尾裁掉一點
        if (fine && b - a > T.minMove + 0.5) { a += HC.clamp(fine.trimHead, 0, (b - a) * 0.25); b -= HC.clamp(fine.trimTail, 0, (b - a) * 0.25); if (fine.trimHead > 0.1 || fine.trimTail > 0.1) why.push("頭尾照你的習慣裁掉一點"); }
        const sh = mk(x.clipId, a, b - a, "move", 0, Lt ? [0.6, 0.8, 1].reduce((bb, v) => Math.abs(v - Lt.moveSpeed) < Math.abs(bb - Lt.moveSpeed) ? v : bb, opt.speed) : opt.speed);
        sh.stab = !!opt.stab; sh.stabStr = opt.stabStr;
        why.unshift(x.lateral ? "橫向運鏡，畫面" + (x.smooth > 0.75 ? "穩" : "還算穩") : x.smooth > 0.75 ? "畫面穩的運鏡" : "運鏡");
        const lk = HC.shotLook(x.clipId, a, b); if (lk) { sh.afx = lk.focus[0]; sh.afy = lk.focus[1]; }
        sh.why = why;
        shots.push(sh);
        return;
      }
      let short = false;
      if (idx > 0) { acc += opt.rhythm; if (acc >= 1) { short = true; acc -= 1; } }
      const longS = Lt ? HC.clamp(Lt.longStill, 3, 12) : T.longStill, shortS = Lt ? HC.clamp(Lt.shortStill, 1.5, 4) : T.shortStill;
      const want = short ? shortS : longS;
      const len = Math.min(x.b - x.a, want);
      const a = x.a + (x.b - x.a - len) / 2;
      const look = HC.shotLook(x.clipId, a, a + len), pref = HC.modePref(look, type);
      const W = (Lt && Lt.modes) || { in: 2, panR: 1, out: 2, panL: 1 };
      const mode = idx === 0 ? "in" : nextMode(W, pref);
      why.unshift(`靜止畫面${short ? "（短鏡頭，做節奏）" : ""}`);
      if (pref && idx) {
        const top = Object.entries(pref).filter(([k]) => k[0] !== "_").sort((p, q) => q[1] - p[1])[0][0];
        if (top === mode) why.push(pref._learned ? `這種畫面你通常用「${MN[mode]}」` : mode === "in" ? "細節集中在中間 → 推近" : mode === "out" ? "畫面細節很平均 → 拉遠" : `${mode === "panR" || mode === "panD" ? "右邊／下面" : "左邊／上面"}細節比較多 → ${MN[mode]}`);
      }
      const zBase = fine && fine.zoomBy[mode] ? fine.zoomBy[mode] : Lt ? HC.clamp(Lt.zoom, 0.04, 0.3) : opt.zoom;
      const sh = mk(x.clipId, a, len, mode, short ? Math.min(0.35, zBase * 1.3) : zBase, 1);
      if (look) { sh.afx = look.focus[0]; sh.afy = look.focus[1]; if (mode === "in" || mode === "out") why.push("推近的目標點對準細節最多的地方"); }
      sh.why = why;
      shots.push(sh);
    });
    // 順序：照拍攝時間，或依學到的「靜止／運鏡」接法重新排（只在同一段場景內調整）
    const ordered = HC.orderShots(shots, opt, L);
    // 轉場：依學到的偏好、或你指定的轉場
    HC.assignTransitions(ordered, opt, L);
    // 長度：調整靜止鏡頭的長短（和運鏡的速度），讓總長接近目標
    HC.fitLength(ordered, opt.len);
    // 剪接點對齊音樂拍點
    if (opt.beat && HC.snapToBeats) HC.snapToBeats(ordered);
    for (const s of ordered) { if (s._beat && s.why) s.why.push("結尾對齊音樂拍點"); delete s._beat; }
    for (const s of ordered) s.orig = { start: s.start, dur: s.dur, mode: s.mode, zoom: s.zoom, speed: s.speed };
    if (dry) { Object.assign(T, HC.TUNE_DEFAULT); return ordered; }
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

  /* ---------- 從素材區拖進時間軸：挑這支素材裡還沒用到、分數最高的片段 ---------- */
  HC.shotFromClip = (c) => {
    if (!c || c.missing) return null;
    const S = HC.state, opt = S.auto, T = HC.TUNE;
    const mk = (start, dur, mode, speed) => ({ id: HC.uid("s"), clipId: c.id, start: +start.toFixed(2), dur: +dur.toFixed(2), mode, zoom: mode === "move" ? 0 : opt.zoom, speed, tr: { type: "cut", dur: 0 }, stab: mode === "move" && !!opt.stab, stabStr: opt.stabStr, why: ["你從素材區拖進來的：這支素材裡還沒用到、分數最高的片段"] });
    if (!c.ana) { if (!c.dur) return null; const a = Math.min(opt.head || 0.5, c.dur / 4); return mk(a, Math.min(5, c.dur - a - 0.05), "in", 1); }
    const used = S.shots.filter((s) => s.clipId === c.id);
    const cands = HC.segmentClip(c, opt).filter((x) => !used.some((s) => x.a < s.start + s.dur && x.b > s.start)).sort((p, q) => q.score - p.score);
    const x = cands[0];
    if (!x) { const a = Math.min(opt.head || 0.5, c.dur / 4); return mk(a, Math.min(5, c.dur - a - 0.05), "in", 1); }
    if (x.type === "M") return mk(x.a, Math.min(x.b - x.a, T.maxMove), "move", opt.speed);
    const len = Math.min(x.b - x.a, T.longStill), a = x.a + (x.b - x.a - len) / 2, s = mk(a, len, "in", 1);
    const lk = HC.shotLook && HC.shotLook(c.id, a, a + len); if (lk) { s.afx = lk.focus[0]; s.afy = lk.focus[1]; }
    return s;
  };

  /* ---------- 換一個：同一支素材（不夠就同一個場景）裡，挑還沒用到、分數最高的片段 ---------- */
  HC.swapShot = (s) => {
    const S = HC.state, opt = S.auto, c = HC.clip(s.clipId);
    if (!c || !c.ana) return null;
    const pool = [c, ...S.clips.filter((x) => x !== c && x.ana && x.scene === c.scene)];
    const rejected = [...(s.rejected || []), [s.clipId, s.start, s.start + s.dur]];
    // 片段裡還沒被其他鏡頭（和你換掉過的）用到的部分
    const free = (x) => {
      let parts = [[x.a, x.b]];
      const used = [...S.shots.filter((o) => o !== s && o.clipId === x.clipId).map((o) => [o.start - 0.5, o.start + o.dur + 0.5]), ...rejected.filter((r) => r[0] === x.clipId).map((r) => [r[1] - 0.3, (r[2] || r[1] + 2) + 0.3])];
      for (const [ua, ub] of used) parts = parts.flatMap(([a, b]) => (ub <= a || ua >= b ? [[a, b]] : [[a, Math.min(b, ua)], [Math.max(a, ub), b]]));
      const min = x.type === "M" ? HC.TUNE.minMove : HC.TUNE.minStill;
      return parts.filter(([a, b]) => b - a >= min).map(([a, b]) => ({ ...x, a, b, score: x.score * (b - a) / (x.b - x.a) }));
    };
    for (const cl of pool) {
      const cands = HC.segmentClip(cl, opt).flatMap(free);
      for (const x of cands) { const p = HC.predict(HC.features(x.clipId, x.a, x.b, x.type === "M")); if (p != null) x.score *= 0.4 + 1.2 * p; }
      cands.sort((p, q) => q.score - p.score);
      const x = cands[0];
      if (!x) continue;
      const out = HC.outDur(s), isMove = x.type === "M";
      const len = isMove ? Math.min(x.b - x.a, Math.max(2, out * opt.speed * 1.3)) : Math.min(x.b - x.a, out);
      const a = x.a + (x.b - x.a - len) / 2, look = HC.shotLook(x.clipId, a, a + len);
      return {
        clipId: x.clipId, start: +a.toFixed(2), dur: +len.toFixed(2), mode: isMove ? "move" : s.mode === "move" ? "in" : s.mode,
        zoom: isMove ? 0 : s.zoom || opt.zoom, speed: isMove ? opt.speed : 1, stab: isMove && !!opt.stab,
        afx: look ? look.focus[0] : undefined, afy: look ? look.focus[1] : undefined,
        rejected: rejected.slice(-20), why: ["你按了「換一個」：這是同一" + (x.clipId === s.clipId ? "支素材" : "個場景") + "裡還沒用到、分數最高的片段"],
      };
    }
    return null;
  };

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
    // 白天的場景排前面、夜晚排後面（同類的照拍攝時間），影片會從白天走到夜晚
    if (opt.dayNight !== false && HC.shotTod) {
      const sc = scenes(shots), rank = (g) => (HC.shotTod(g[0]) === "night" ? 1 : 0);
      shots = sc.map((g, k) => [g, k]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).flatMap(([g]) => g);
    }
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

  /* ---------- 長度：讓總長接近目標 ----------
     先調靜止鏡頭（2～12 秒，素材夠長才能拉長），不夠再微調運鏡的速度（0.6～1.25 倍） */
  HC.fitLength = (shots, target) => {
    if (!target || !shots.length) return;
    const saved = HC.state.shots; HC.state.shots = shots;
    try {
      for (let pass = 0; pass < 4; pass++) {
        const total = HC.timeline().total, diff = target - total;
        if (Math.abs(diff) < Math.max(1, target * 0.03)) break;
        const stills = shots.filter((s) => s.mode !== "move");
        const room = (s) => { const c = HC.clip(s.clipId); return diff > 0 ? Math.min(12, c && c.dur ? c.dur - s.start - 0.05 : 12) - s.dur : s.dur - 2; };
        const R = stills.reduce((a, s) => a + Math.max(0, room(s)), 0);
        if (R > 0.5) {
          for (const s of stills) { const r = Math.max(0, room(s)), d = HC.clamp(diff * r / R, -r, r); s.dur = +(s.dur + d).toFixed(2); }
        } else {
          const moves = shots.filter((s) => s.mode === "move"), md = moves.reduce((a, s) => a + s.dur / s.speed, 0);
          if (!md) break;
          const f = HC.clamp(md / Math.max(1, md + diff), 0.6 / 0.8, 1.25 / 0.8);
          for (const s of moves) s.speed = +HC.clamp(s.speed * f, 0.6, 1.25).toFixed(2);
        }
      }
    } finally { HC.state.shots = saved; }
  };

  /* ---------- 做好幾個版本讓你挑 ---------- */
  HC.VARIANTS = [
    { id: "calm", name: "慢慢欣賞", desc: "長鏡頭、慢運鏡，適合仔細看佈置", over: { rhythm: 0.15, speed: 0.6, T: { longStill: 8, shortStill: 3.5 } } },
    { id: "brisk", name: "節奏輕快", desc: "長短鏡頭交錯、運鏡原速", over: { rhythm: 0.75, speed: 1, T: { longStill: 4.5, shortStill: 2 } } },
    { id: "teaser", name: "60 秒精華", desc: "只留最好看的鏡頭", over: { len: 60, rhythm: 0.55, speed: 0.8, cover: false, T: { longStill: 5, shortStill: 2.5 } } },
  ];
  HC.makeVariants = () => HC.VARIANTS.map((v) => ({ ...v, shots: HC.autoEdit(v.over, true) }));

  /* ---------- 短影音版：從目前的時間軸挑最好的鏡頭 ---------- */
  HC.makeShort = (shots, target = 45) => {
    const score = (s) => (s.fb === 1 ? 3 : s.fb === -1 ? -3 : 0) + (HC.predict ? HC.predict(HC.features(s.clipId, s.start, s.start + s.dur, s.mode === "move")) || 0.5 : 0.5) + (s.split ? 1 : 0) + (s.labels ? 0.3 : 0);
    const ranked = shots.map((s, i) => ({ s, i, sc: score(s) })).sort((a, b) => b.sc - a.sc);
    const keep = []; let t = 0;
    for (const r of ranked) {
      const s = JSON.parse(JSON.stringify(r.s)); s.id = HC.uid("s");
      if (s.mode === "move") { s.speed = Math.max(s.speed, 1); s.dur = Math.min(s.dur, 5 * s.speed); delete s.freeze; }
      else s.dur = Math.min(s.dur, 3.5);
      const d = s.dur / s.speed;
      if (t + d > target + 2) continue;
      keep.push({ s, i: r.i }); t += d;
      if (t >= target - 2) break;
    }
    const out = keep.sort((a, b) => a.i - b.i).map((k) => k.s);
    out.forEach((s, k) => { s.tr = k ? { type: "cut", dur: 0 } : s.tr; s.why = ["短影音版：從完整版挑出分數最高的鏡頭"]; });
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
