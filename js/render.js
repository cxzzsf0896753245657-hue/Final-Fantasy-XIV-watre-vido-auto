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
  const mt = (v) => (v._mt != null && !v.seeking ? v._mt : v.currentTime);

  R.init = (cv) => { canvas = cv; ctx = cv.getContext("2d"); clear(); };
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
  function drawShot(c, v, s, lt) {
    const W = canvas.width, H = canvas.height, od = HC.outDur(s);
    const e = ease(lt / od), k = s.zoom || 0;
    let z = 1, fx = 0.5, fy = 0.5;
    switch (s.mode) {
      case "in": z = 1 + k * e; break;
      case "out": z = 1 + k - k * e; break;
      case "panR": z = 1 + k; fx = e; break;
      case "panL": z = 1 + k; fx = 1 - e; break;
      case "panU": z = 1 + k; fy = 1 - e; break;
      case "panD": z = 1 + k; fy = e; break;
      case "none": z = 1 + k; break;
    }
    const vw = v.videoWidth || 1920, vh = v.videoHeight || 1080;
    const st = s.stab ? HC.stabOffset(s, mt(v)) : null;   // 防抖：稍微放大，再把畫面往晃動的反方向挪
    if (st) z *= HC.stabCrop(s);
    const sc = Math.max(W / vw, H / vh) * z, sw = W / sc, sh = H / sc;
    let sx = (vw - sw) * fx, sy = (vh - sh) * fy;
    if (st) { sx = HC.clamp(sx + st[0] * vw, 0, vw - sw); sy = HC.clamp(sy + st[1] * vh, 0, vh - sh); }
    const f = HC.filterInfo(s.filter || HC.state.look.filter);
    if (HC.canFilter) c.filter = f.css || "none";
    c.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
    if (HC.canFilter) c.filter = "none";
  }

  /* 疊加層需要的資訊 */
  R.overlayInfo = (T, still) => {
    const S = HC.state, { starts, total } = HC.timeline();
    return {
      // 暫停時不套片頭片尾的淡入淡出，才看得到畫面
      T, total, fi: still ? 0 : S.out.fi, fo: still ? 0 : S.out.fo, look: S.look, title: S.title, ending: S.ending,
      captions: S.shots.map((s, i) => s.text ? { text: s.text, start: starts[i], dur: HC.outDur(s) } : null).filter(Boolean),
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
    HC.drawOverlay(ctx, W, H, R.overlayInfo(T, still), canvas);
    lastDraw = performance.now();
  }

  /* ---------- 載入某個鏡頭到某個 video ---------- */
  async function load(v, s, off) {
    const c = HC.clip(s.clipId);
    if (!c) throw new Error("missing clip");
    if (v.dataset.clip !== c.id) { v.src = c.url; v.dataset.clip = c.id; await HC.once(v, "loadeddata", 15000); }
    v.playbackRate = s.speed;
    const target = HC.clamp(s.start + off * s.speed, 0, (v.duration || 1e9) - 0.05);
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
        if (tk !== token) return;
        idx = at.i - 1; R.T = T;
        compose(T, vids[cur], at.i - 1, T - starts[at.i - 1], vids[1 - cur], at.i, at.off, true);
      } else {
        await load(vids[cur], S.shots[at.i], at.off);
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
    R.music.stop();
    R.onState && R.onState(false);
  };
  R.isPlaying = () => playing;

  function state() {
    const S = HC.state, s = S.shots[idx], v = vids[cur];
    if (!s) return null;
    const { starts } = HC.timeline();
    const lt = (mt(v) - s.start) / s.speed;
    const T = starts[idx] + HC.clamp(lt, 0, HC.outDur(s));
    const nlt = nextOn ? Math.max(0, (mt(vids[1 - cur]) - S.shots[idx + 1].start) / S.shots[idx + 1].speed) : null;
    return { s, v, lt, T, nlt, od: HC.outDur(s) };
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
      else if (st.lt >= st.od - 0.017 || st.v.ended) advance(tk);
      else {
        if (!st.v._rvfc || performance.now() - lastDraw > 50) draw();
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
    nv.playbackRate = HC.state.shots[idx + 1].speed;
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
    v.playbackRate = S.shots[idx].speed;
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

  /* ---------- 背景音樂 ---------- */
  const au = new Audio();
  au.preload = "auto";
  let actx = null, gain = null, dest = null, held = false;
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
    level(T) {
      const M = HC.state.music, { total } = HC.timeline();
      let g = M.vol;
      if (M.fade > 0 && T > total - M.fade) g *= HC.clamp((total - T) / M.fade, 0, 1);
      if (T < 0.5) g *= T / 0.5;
      return g;
    },
    start(T) {
      const M = HC.state.music;
      if (!M.url) return;
      this.ensure();
      actx.resume && actx.resume();
      if (au.src !== M.url) au.src = M.url;
      au.currentTime = M.off + T;
      gain.gain.value = this.level(T);
      au.play().catch(() => {});
    },
    sync(T) {
      const M = HC.state.music;
      if (!M.url || !actx || held) return;
      gain.gain.value = this.level(T);
      if (Math.abs(au.currentTime - (M.off + T)) > 0.2) au.currentTime = M.off + T;
    },
    hold(on) { held = on; if (!HC.state.music.url) return; on ? au.pause() : au.play().catch(() => {}); },
    stop() { au.pause(); },
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
    const h = S.out.res === 720 ? 720 : 1080;
    canvas.width = h * 16 / 9; canvas.height = h;
    const stream = canvas.captureStream(30);
    if (S.music.url) for (const tr of R.music.stream().getAudioTracks()) stream.addTrack(tr);
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: S.out.rate * 1e6, audioBitsPerSecond: 192000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const restore = () => { R.exporting = false; canvas.width = H0 * 16 / 9; canvas.height = H0; R.onTime = prevOnTime; };
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
