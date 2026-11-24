/* 畫面合成、播放與匯出
   - 兩個 <video> 輪流播放：一個播目前的鏡頭，另一個先跳到下一個鏡頭等著
   - 有轉場時，兩個鏡頭會重疊一段時間同時播放，分別畫到兩張暫存畫布，再用 effects.js 的轉場效果合成
   - 每一格：縮放／平移／防抖／濾鏡 → 轉場 → 特效、標題、片尾、黑場（effects.js 的 drawOverlay）
   - 匯出時把畫布和背景音樂即時錄成影片檔
*/
{
  const HC = window.HC;
  const R = HC.R = {};
  const vids = [mkVideo(), mkVideo()];
  let cur = 0, idx = -1, playing = false, token = 0, nextReady = null, advancing = false, waitHooks = null, nextOn = false, lastDraw = 0;
  let canvas, ctx, bufA, bufB;
  R.T = 0;

  function mkVideo() {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    // 在「新畫格出現」的當下繪製，畫面和時間才會精準對上（防抖需要）
    if ("requestVideoFrameCallback" in v) {
      const cb = (now, meta) => { v._mt = meta.mediaTime; onFrame(v); v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
      v.addEventListener("seeked", () => { v._mt = v.currentTime; });
      v._rvfc = true;
    }
    return v;
  }
  // 畫面的素材時間（逐格匯出時 v 可能是解碼出來的 VideoFrame）
  // 流暢預覽用的代理檔時間從 0 開始，原始素材可能從 0.05 秒開始：_shift 把它換回原始素材的時間
  const mt = (v) => (v.timestamp != null && v.currentTime == null ? v.timestamp / 1e6 : (v._mt != null && !v.seeking ? v._mt : v.currentTime) + (v._shift || 0));

  R.init = (cv) => { canvas = cv; ctx = cv.getContext("2d"); clear(); };
  R.canvas = () => canvas;
  function clear() { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  function buffers() {
    for (const k of ["A", "B"]) {
      let b = k === "A" ? bufA : bufB;
      if (!b) { b = document.createElement("canvas"); if (k === "A") bufA = b; else bufB = b; }
      if (b.width !== canvas.width || b.height !== canvas.height) { b.width = canvas.width; b.height = canvas.height; }
    }
  }

  /* ---------- 一個鏡頭的單格：縮放、平移、防抖、濾鏡 ---------- */
  const ease = (p) => 0.5 - 0.5 * Math.cos(Math.PI * HC.clamp(p, 0, 1));
  /* 鏡頭用到的其他素材（日夜對比的另一邊、子母畫面）：播放時用額外的 <video>，逐格匯出時由 export.js 提供 */
  const exPool = new Map();
  R.exOverride = null;   // 逐格匯出：Map(「鏡頭 id:種類」→ 畫面)
  const exSpecs = (s) => [s.split ? ["split", s.split] : null, s.pip ? ["pip", s.pip] : null].filter(Boolean);
  HC.exSpecs = exSpecs;
  const exGet = (s, kind) => {
    if (R.exOverride) return R.exOverride.get(s.id + ":" + kind) || null;
    const v = exPool.get(s.id + ":" + kind);
    return v && v.readyState >= 2 ? v : null;
  };
  function exEl(key) {
    let v = exPool.get(key);
    if (!v) { v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto"; exPool.set(key, v); }
    return v;
  }
  /* exact：暫停狀態要等跳轉完成；播放中只在差太多時修正 */
  async function exSync(s, lt, exact) {
    for (const [kind, ref] of exSpecs(s)) {
      const c = HC.clip(ref.clipId); if (!c || !c.url) continue;
      const v = exEl(s.id + ":" + kind), t = HC.clamp(ref.start + lt * s.speed, 0, (c.dur || 1e9) - 0.05);
      if (v.dataset.clip !== c.id) { v.src = c.url; v.dataset.clip = c.id; v._loading = HC.once(v, "loadeddata", 15000).catch(() => {}); }
      if (v._loading) { if (!exact) { v._loading.then(() => { v._loading = null; }); continue; } await v._loading; v._loading = null; }
      if (exact) { v.pause(); if (Math.abs(v.currentTime - t) > 0.02) { v.currentTime = t; await HC.once(v, "seeked", 8000).catch(() => {}); } }
      else {
        v.playbackRate = s.speed;
        if (Math.abs(v.currentTime - t) > 0.3) v.currentTime = t;
        if (v.paused && playing) v.play().catch(() => {});
      }
    }
  }
  function exPauseExcept(keep) { for (const [k, v] of exPool) if (!keep.has(k.split(":")[0])) v.pause(); }
  R.exSync = exSync;

  function drawShot(c, v, s, lt) {
    const W = canvas.width, H = canvas.height;
    const vw = v.videoWidth || v.displayWidth || 1920, vh = v.videoHeight || v.displayHeight || 1080;
    const st = s.stab ? HC.stabOffset(s, mt(v)) : null;   // 防抖：稍微放大，再把畫面往晃動的反方向挪
    // 以目標點為中心縮放：目標點在畫面上的位置不變，周圍放大（直式時也用它決定保留哪一塊）
    const cr = HC.cropAt(s, lt, vw, vh, W, H, st, st ? HC.stabCrop(s) : 1);
    const L = HC.state.look, filt = [HC.adjCss(s), HC.filterCss(s.filter || L.filter, L.filterStr ?? 1)].filter(Boolean).join(" ") || "none";
    if (HC.canFilter) c.filter = filt;
    c.drawImage(v, cr.sx, cr.sy, cr.sw, cr.sh, 0, 0, W, H);
    // 日夜對比：另一邊用同樣的裁切，分隔線從右掃到左
    const sv = s.split && exGet(s, "split");
    if (sv) {
      const d = HC.splitPos(lt, HC.outDur(s));
      c.save(); c.beginPath(); c.rect(W * d, 0, W * (1 - d), H); c.clip();
      const bw = sv.videoWidth || sv.displayWidth || vw, bh = sv.videoHeight || sv.displayHeight || vh, cb = HC.cropAt(s, lt, bw, bh, W, H);
      c.drawImage(sv, cb.sx, cb.sy, cb.sw, cb.sh, 0, 0, W, H);
      c.restore();
    }
    if (HC.canFilter) c.filter = "none";
    // 色溫：暖色／冷色的柔光層
    const tf = HC.tempFill(s);
    if (tf) { c.save(); c.globalCompositeOperation = "soft-light"; c.fillStyle = tf; c.fillRect(0, 0, W, H); c.restore(); }
    if (s.split) HC.drawSplitUI(c, W, H, HC.splitPos(lt, HC.outDur(s)), s.split.labels || ["白天", "夜晚"], lt, HC.outDur(s));
    // 子母畫面
    const pv = s.pip && exGet(s, "pip");
    if (pv) HC.drawPip(c, W, H, pv, s.pip, lt, HC.outDur(s), HC.canFilter ? filt : "");
    // 標註：跟著畫面一起動
    if (s.labels && s.labels.length) for (const lb of s.labels) {
      const [x, y] = HC.toScreen(cr, lb.x, lb.y, vw, vh);
      HC.drawLabel(c, W, H, x * W, y * H, lb, lt, HC.outDur(s));
    }
  }

  /* 疊加層需要的資訊 */
  R.overlayInfo = (T, still) => {
    const S = HC.state, { starts, total } = HC.timeline();
    return {
      // 暫停時不套片頭片尾的淡入淡出，才看得到畫面
      T, total, fi: still ? 0 : S.out.fi, fo: still ? 0 : S.out.fo, look: S.look, title: S.title, ending: S.ending, wm: S.wm,
      captions: [...S.shots.map((s, i) => s.text ? { text: s.text, start: starts[i], dur: HC.outDur(s) } : null).filter(Boolean),
        ...(S.texts || []).map((t) => { const [a, b] = HC.textSpan(t, null, total); const k = S.look.text || {}; return { text: t.text, sub: t.sub, style: t.style, pos: t.pos, start: a, dur: b - a, color: t.color || k.color, accent: k.accent, weight: k.weight, track: k.track, box: t.box ?? false }; })],
      fxItems: S.fxItems || [],
    };
  };

  /* 合成一格：primary 是目前（或轉場中前一個）鏡頭，next 有值代表正在轉場 */
  function compose(T, pv, pi, plt, nv, ni, nlt, still) {
    const S = HC.state, W = canvas.width, H = canvas.height;
    if (nv != null && ni != null) {
      buffers();
      drawShot(bufA.getContext("2d"), pv, S.shots[pi], plt);
      drawShot(bufB.getContext("2d"), nv, S.shots[ni], nlt);
      const { starts } = HC.timeline(), s = S.shots[ni], d = HC.trDur(ni);
      HC.drawTransition(ctx, bufA, bufB, d ? (T - starts[ni]) / d : 1, s.tr ? s.tr.type : "cut", W, H);
    } else drawShot(ctx, pv, S.shots[pi], plt);
    if (!R.noOverlay) HC.drawOverlay(ctx, W, H, R.overlayInfo(T, still), canvas);
    lastDraw = performance.now();
  }
  R.compose = compose;   // 逐格匯出（export.js）用

  /* ---------- 載入某個鏡頭到某個 video ---------- */
  async function load(v, s, off) {
    const c = HC.clip(s.clipId);
    if (!c) throw new Error("missing clip");
    const px = HC.state.out.proxy && c.proxyUrl, url = px ? c.proxyUrl : c.url;
    if (v.dataset.clip !== c.id || v.dataset.url !== url) { v.src = url; v.dataset.clip = c.id; v.dataset.url = url; v._shift = px ? c.proxyShift || 0 : 0; v._mt = null; await HC.once(v, "loadeddata", 15000); }
    frozenAt.delete(v);
    v.playbackRate = HC.clamp(HC.rateAt(s, off), 0.0625, 16);
    const target = HC.clamp(HC.srcTime(s, off) - (v._shift || 0), 0, (v.duration || 1e9) - 0.05);
    if (Math.abs(v.currentTime - target) > 0.01) { v.currentTime = target; await HC.once(v, "seeked"); }
  }
  function prepareNext(tk) {
    const s = HC.state.shots[idx + 1];
    if (!s) { nextReady = null; return; }
    nextReady = load(vids[1 - cur], s, 0).then(() => tk === token).catch(() => false);
  }

  /* ---------- 跳到某個時間（暫停狀態） ---------- */
  R.seek = async (T) => {
    if (R.exporting) return;   // 匯出中不能動播放位置
    R.stop();
    const tk = ++token;
    const at = HC.shotAt(T);
    if (!at) { clear(); R.T = 0; R.onTime && R.onTime(0); return; }
    const S = HC.state, { starts } = HC.timeline();
    try {
      if (at.overlap) {
        await load(vids[cur], S.shots[at.i - 1], T - starts[at.i - 1]);
        await load(vids[1 - cur], S.shots[at.i], at.off);
        await exSync(S.shots[at.i - 1], T - starts[at.i - 1], true); await exSync(S.shots[at.i], at.off, true);
        if (tk !== token) return;
        idx = at.i - 1; R.T = T;
        compose(T, vids[cur], at.i - 1, T - starts[at.i - 1], vids[1 - cur], at.i, at.off, true);
      } else {
        await load(vids[cur], S.shots[at.i], at.off);
        await exSync(S.shots[at.i], at.off, true);
        if (tk !== token) return;
        idx = at.i; R.T = T;
        compose(T, vids[cur], at.i, at.off, null, null, null, true);
      }
    } catch (e) { return; }
    R.onTime && R.onTime(T);
  };

  /* ---------- 播放 ---------- */
  R.play = async (T, hooks) => {
    if (R.exporting && !hooks) return false;
    R.stop(true);
    const tk = ++token;
    const at = HC.shotAt(T);
    if (!at) return false;
    const S = HC.state, { starts } = HC.timeline();
    try {
      if (at.overlap) {
        await load(vids[cur], S.shots[at.i - 1], T - starts[at.i - 1]);
        await load(vids[1 - cur], S.shots[at.i], at.off);
        idx = at.i - 1; nextOn = true;
      } else {
        await load(vids[cur], S.shots[at.i], at.off);
        idx = at.i; nextOn = false;
      }
    } catch (e) { R.onError && R.onError(e); return false; }
    if (tk !== token) return false;
    waitHooks = hooks || null;
    if (nextOn) compose(T, vids[cur], idx, T - starts[idx], vids[1 - cur], idx + 1, at.off); else compose(T, vids[cur], idx, at.off);
    hooks && hooks.ready && (await hooks.ready());
    if (!nextOn) prepareNext(tk); else nextReady = null;
    playing = true;
    R.music.start(T);
    await vids[cur].play().catch(() => {});
    if (nextOn) await vids[1 - cur].play().catch(() => {});
    R.onState && R.onState(true);
    requestAnimationFrame(() => loop(tk));
    return true;
  };
  /* force：匯出中只有匯出流程自己能停 */
  R.stop = (force) => {
    if (R.exporting && !force) return;
    playing = false; advancing = false; nextOn = false;
    vids.forEach((v) => v.pause());
    for (const v of exPool.values()) v.pause();
    R.music.stop();
    R.onState && R.onState(false);
  };
  R.isPlaying = () => playing;

  /* 影片時間 → 鏡頭時間；定格的部分影片已經停了，改用時鐘算 */
  const frozenAt = new WeakMap();
  function ltOf(v, s) {
    let lt = HC.ltOfSrc(s, mt(v));
    const md = HC.moveDur(s);
    if (s.freeze > 0 && lt >= md - 0.03) {
      if (!frozenAt.has(v)) frozenAt.set(v, performance.now() - Math.max(0, lt - md) * 1000);
      if (!v.paused) v.pause();   // 停在最後一格（緩衝結束後恢復播放時也要再停一次）
      lt = md + (performance.now() - frozenAt.get(v)) / 1000;
    } else frozenAt.delete(v);
    return lt;
  }
  // 速度曲線：播放中一直調整播放速度
  function steer(v, s, lt) {
    if (s.mode !== "move" || !s.ramp || lt >= HC.moveDur(s)) return;
    const r = HC.clamp(HC.rateAt(s, lt), 0.0625, 16);
    if (Math.abs(v.playbackRate - r) > 0.02) v.playbackRate = r;
  }
  function state() {
    const S = HC.state, s = S.shots[idx], v = vids[cur];
    if (!s) return null;
    const { starts } = HC.timeline();
    const lt = ltOf(v, s);
    const T = starts[idx] + HC.clamp(lt, 0, HC.outDur(s));
    const ns = S.shots[idx + 1];
    const nlt = nextOn ? Math.max(0, ltOf(vids[1 - cur], ns)) : null;
    return { s, v, lt, T, nlt, ns, od: HC.outDur(s) };
  }
  function draw() {
    const st = state();
    if (!st || st.lt < 0 || st.lt >= st.od) return;
    if (nextOn) compose(st.T, st.v, idx, st.lt, vids[1 - cur], idx + 1, st.nlt); else compose(st.T, st.v, idx, st.lt);
  }
  function onFrame(v) {
    if (!playing || advancing || v !== vids[cur]) return;
    draw();
  }

  function loop(tk) {
    if (!playing || tk !== token) return;
    const st = state();
    if (!st) { finish(); return; }
    if (!advancing) {
      const S = HC.state, { starts } = HC.timeline(), ni = idx + 1;
      // 轉場開始：讓下一個鏡頭也開始播
      if (!nextOn && S.shots[ni] && HC.trDur(ni) > 0 && st.T >= starts[ni]) startNext(tk);
      else if (st.lt >= st.od - 0.017 || (st.v.ended && !(st.s.freeze > 0))) advance(tk);
      else {
        steer(st.v, st.s, st.lt); if (nextOn && st.ns) steer(vids[1 - cur], st.ns, st.nlt);
        exSync(st.s, st.lt, false); if (nextOn && st.ns) exSync(st.ns, st.nlt, false);
        exPauseExcept(new Set([st.s.id, nextOn && st.ns ? st.ns.id : ""]));
        if (!st.v._rvfc || st.v.paused || performance.now() - lastDraw > 50) draw();
        R.T = st.T; R.music.sync(st.T); R.onTime && R.onTime(st.T);
      }
    }
    requestAnimationFrame(() => loop(tk));
  }
  async function startNext(tk) {
    advancing = true;
    let ok = nextReady ? await withWait(nextReady) : false;
    if (tk !== token) return;
    if (!ok) ok = await withWait(load(vids[1 - cur], HC.state.shots[idx + 1], 0).then(() => true).catch(() => false));
    if (!ok || tk !== token) { R.stop(true); finishHooks(); return; }
    nextOn = true;
    const nv = vids[1 - cur];
    nv.playbackRate = HC.clamp(HC.rateAt(HC.state.shots[idx + 1], 0), 0.0625, 16);
    await nv.play().catch(() => {});
    advancing = false;
  }
  async function advance(tk) {
    advancing = true;
    const S = HC.state;
    vids[cur].pause();
    if (idx + 1 >= S.shots.length) { finish(); return; }
    if (nextOn) {   // 轉場結束：下一個鏡頭已經在播了，直接接手
      cur = 1 - cur; idx++; nextOn = false;
      prepareNext(tk);
      advancing = false;
      return;
    }
    let ok = nextReady ? await withWait(nextReady) : false;
    if (tk !== token) return;
    if (!ok) {
      ok = await withWait(load(vids[1 - cur], S.shots[idx + 1], 0).then(() => true).catch(() => false));
      if (!ok || tk !== token) { R.stop(true); finishHooks(); return; }
    }
    cur = 1 - cur; idx++;
    const v = vids[cur];
    v.playbackRate = HC.clamp(HC.rateAt(S.shots[idx], 0), 0.0625, 16);
    await v.play().catch(() => {});
    prepareNext(tk);
    advancing = false;
  }
  async function withWait(p) {
    let settled = false, val;
    p.then((x) => { settled = true; val = x; });
    await Promise.resolve();
    if (settled) return val;
    waitHooks && waitHooks.pause && waitHooks.pause();
    vids.forEach((v) => v.pause());
    R.music.hold(true);
    val = await p;
    R.music.hold(false);
    if (playing) { vids[cur].play().catch(() => {}); if (nextOn) vids[1 - cur].play().catch(() => {}); }
    waitHooks && waitHooks.resume && waitHooks.resume();
    return val;
  }
  function finish() {
    const { total } = HC.timeline();
    R.stop(true);
    R.T = total;
    R.onTime && R.onTime(total);
    finishHooks();
  }
  // 播放結束（或素材載入失敗中斷）時通知匯出流程，避免一直等下去
  function finishHooks() { const h = waitHooks; waitHooks = null; h && h.done && h.done(); }

  /* ---------- 背景音樂 + 環境音效 ----------
     音樂一條，環境音效最多 3 層（循環播放、開頭 1.5 秒淡入、結尾跟音樂一起淡出） */
  const au = new Audio();
  au.preload = "auto";
  let actx = null, gain = null, dest = null, held = false;
  const layers = new Map();   // 環境音效 key -> { au, gain }
  const fadeOut = (T, total, f) => (f > 0 && T > total - f ? HC.clamp((total - T) / f, 0, 1) : 1);
  function layer(a) {
    let L = layers.get(a.key);
    if (!L) {
      const el = new Audio(); el.loop = true; el.preload = "auto";
      const g = actx.createGain(), src = actx.createMediaElementSource(el);
      src.connect(g); g.connect(actx.destination); g.connect(dest);
      L = { au: el, gain: g }; layers.set(a.key, L);
    }
    if (L.au.src !== a.url) L.au.src = a.url;
    return L;
  }
  const ambTime = (L, T, a) => { const t = Math.max(0, T - ((a && a.start) || 0)); return L.au.duration > 0 ? t % L.au.duration : t; };
  function dropLayers() {
    const keep = new Set(HC.state.amb.map((a) => a.key));
    for (const [k, L] of layers) if (!keep.has(k)) { L.au.pause(); L.au.removeAttribute("src"); L.gain.disconnect(); layers.delete(k); }
  }
  R.music = {
    el: au,
    ensure() {
      if (actx) return;
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const src = actx.createMediaElementSource(au);
      gain = actx.createGain();
      dest = actx.createMediaStreamDestination();
      src.connect(gain); gain.connect(actx.destination); gain.connect(dest);
    },
    stream() { this.ensure(); return dest.stream; },
    has: () => !!HC.state.music.url || HC.state.amb.length > 0,
    /* 音樂軌：只在 [at, 結束] 之間有聲音；開頭 0.5 秒淡入、結尾淡出 */
    musicSpan() {
      const M = HC.state.music, { total } = HC.timeline(), a = M.at || 0;
      const dur = this.el.duration > 0 ? this.el.duration - (M.off || 0) : 1e9;
      return [a, Math.min(total, a + (M.len > 0 ? M.len : 1e9), a + dur)];
    },
    level(T) {
      const M = HC.state.music, [a, b] = this.musicSpan();
      if (T < a || T >= b) return 0;
      let g = M.vol * fadeOut(T, b, M.fade);
      if (T - a < 0.5 && a > 0.01) g *= (T - a) / 0.5; else if (T < 0.5) g *= T / 0.5;
      return g;
    },
    musicTime: (T) => (HC.state.music.off || 0) + (T - (HC.state.music.at || 0)),
    ambLevel(a, T) {
      const [s, e] = HC.spanOf(a);
      if (T < s || T >= e) return 0;
      return a.vol * fadeOut(T, e, Math.max(1.5, HC.state.music.fade)) * HC.clamp((T - s) / 1.5, 0, 1);
    },
    start(T) {
      const M = HC.state.music;
      if (!this.has()) return;
      this.ensure();
      actx.resume && actx.resume();
      dropLayers();
      if (M.url) {
        if (au.src !== M.url) au.src = M.url;
        au.currentTime = Math.max(0, this.musicTime(T));
        gain.gain.value = this.level(T);
        if (T >= (M.at || 0)) au.play().catch(() => {}); else au.pause();
      }
      for (const a of HC.state.amb) {
        const L = layer(a);
        L.au.currentTime = ambTime(L, T, a); L.gain.gain.value = this.ambLevel(a, T);
        L.au.play().catch(() => {});
      }
    },
    sync(T) {
      const M = HC.state.music;
      if (!actx || held) return;
      if (M.url) {
        gain.gain.value = this.level(T);
        const want = this.musicTime(T);
        if (want < 0) { if (!au.paused) au.pause(); }
        else { if (au.paused) au.play().catch(() => {}); if (Math.abs(au.currentTime - want) > 0.2) au.currentTime = want; }
      }
      for (const a of HC.state.amb) {
        const L = layers.get(a.key); if (!L) continue;
        L.gain.gain.value = this.ambLevel(a, T);
        const want = ambTime(L, T, a);
        if (Math.abs(L.au.currentTime - want) > 0.35 && Math.abs(L.au.currentTime - want) < (L.au.duration || 1e9) - 0.35) L.au.currentTime = want;
      }
    },
    hold(on) {
      held = on;
      const all = [HC.state.music.url ? au : null, ...[...layers.values()].map((L) => L.au)].filter(Boolean);
      for (const el of all) on ? el.pause() : el.play().catch(() => {});
    },
    stop() { au.pause(); for (const L of layers.values()) L.au.pause(); },
  };

  /* ---------- 匯出 ---------- */
  R.pickMime = () => {
    const list = ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1.4d0028", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    for (const m of list) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return "";
  };

  R.exportVideo = (onProgress) => new Promise(async (resolve, reject) => {
    const S = HC.state;
    if (!window.MediaRecorder) return reject(new Error("這個瀏覽器不支援錄製，請改用 Chrome 或 Edge"));
    const mime = R.pickMime();
    R.stop();
    R.exporting = true;
    const H0 = canvas.height;
    const H0w = canvas.width, sz = HC.outSize();
    canvas.width = sz.W; canvas.height = sz.H;
    const stream = canvas.captureStream(30);
    if (R.music.has()) for (const tr of R.music.stream().getAudioTracks()) stream.addTrack(tr);
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: S.out.rate * 1e6, audioBitsPerSecond: 192000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const restore = () => { R.exporting = false; canvas.width = H0w; canvas.height = H0; R.onTime = prevOnTime; };
    rec.onstop = () => {
      restore();
      resolve({ blob: new Blob(chunks, { type: (mime || "video/webm").split(";")[0] }), ext: (mime || "webm").includes("mp4") ? "mp4" : "webm" });
    };
    const prevOnTime = R.onTime;
    const { total } = HC.timeline();
    R.onTime = (T) => { prevOnTime && prevOnTime(T); onProgress && onProgress(T / total); };
    R.cancelExport = () => { R.stop(true); if (rec.state !== "inactive") rec.stop(); };
    const ok = await R.play(0, {
      ready: async () => { rec.start(1000); },
      pause: () => { if (rec.state === "recording") rec.pause(); },
      resume: () => { if (rec.state === "paused") rec.resume(); },
      done: () => { setTimeout(() => rec.state !== "inactive" && rec.stop(), 250); },
    });
    if (!ok) { if (rec.state !== "inactive") { rec.onstop = null; rec.stop(); } restore(); reject(new Error("有鏡頭的素材無法載入")); }
  });
}
