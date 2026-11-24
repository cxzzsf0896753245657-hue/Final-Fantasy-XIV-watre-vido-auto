/* 畫面合成、播放與匯出
   - 用兩個 <video> 輪流播放：一個在播目前的鏡頭，另一個先跳到下一個鏡頭的位置等著，切換時就不會卡
   - 每一格畫面畫到 canvas 上：套用縮放／平移、黑場、標題文字
   - 匯出時把 canvas 和背景音樂即時錄成影片檔
*/
{
  const HC = window.HC;
  const R = HC.R = {};
  const vids = [mkVideo(), mkVideo()];
  let cur = 0, idx = -1, playing = false, token = 0, nextReady = null, advancing = false, waitHooks = null;
  let canvas, ctx;
  R.T = 0;

  function mkVideo() {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    // 記下目前真正顯示的那一格的時間（防抖要對準這一格，不能用 currentTime）
    // 播放時在「新畫格出現」的當下繪製，畫面和時間才會精準對上（防抖需要）
    if ("requestVideoFrameCallback" in v) {
      const cb = (now, meta) => { v._mt = meta.mediaTime; onFrame(v, meta.mediaTime); v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
      v.addEventListener("seeked", () => { v._mt = v.currentTime; });
      v._rvfc = true;
    }
    return v;
  }

  R.init = (cv) => { canvas = cv; ctx = cv.getContext("2d"); clear(); };
  function clear() { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height); }

  /* ---------- 單格畫面 ---------- */
  const ease = (p) => 0.5 - 0.5 * Math.cos(Math.PI * HC.clamp(p, 0, 1));

  R.drawFrame = (v, s, lt, T, i, still) => {
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
    // 防抖：稍微放大，再把畫面往晃動的反方向挪
    const st = s.stab ? HC.stabOffset(s, v._mt != null && !v.seeking ? v._mt : v.currentTime) : null;   // 用正在顯示那一格的時間
    if (st) z *= HC.stabCrop(s);
    const sc = Math.max(W / vw, H / vh) * z;
    const sw = W / sc, sh = H / sc;
    let sx = (vw - sw) * fx, sy = (vh - sh) * fy;
    if (st) { sx = HC.clamp(sx + st[0] * vw, 0, vw - sw); sy = HC.clamp(sy + st[1] * vh, 0, vh - sh); }
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);

    // 黑場：片頭淡入、片尾淡出、指定的黑場轉場
    const S = HC.state, { total } = HC.timeline();
    let black = 0;
    // 暫停時不套用片頭片尾的淡入淡出，才看得到畫面
    if (!still && S.out.fi > 0 && T < S.out.fi) black = Math.max(black, 1 - T / S.out.fi);
    if (!still && S.out.fo > 0 && T > total - S.out.fo) black = Math.max(black, 1 - (total - T) / S.out.fo);
    const D = 0.6;
    if (s.dip && lt < D) black = Math.max(black, 1 - lt / D);
    const nx = S.shots[i + 1];
    if (nx && nx.dip && od - lt < D) black = Math.max(black, 1 - (od - lt) / D);
    if (black > 0.001) { ctx.fillStyle = `rgba(0,0,0,${HC.clamp(black, 0, 1)})`; ctx.fillRect(0, 0, W, H); }

    if (i === 0 && S.title.show) drawTitle(lt);
    if (s.text) drawCaption(s.text, lt, od);
  };

  const fadeA = (t, a, b, f = 0.8) => t < a ? 0 : t < a + f ? (t - a) / f : t < b - f ? 1 : t < b ? (b - t) / f : 0;

  function drawTitle(t) {
    const Ti = HC.state.title, W = canvas.width, H = canvas.height, u = H / 1080;
    const end = Ti.dur + 0.8;
    const a1 = fadeA(t, 0.8, end), a2 = fadeA(t, 1.3, end);
    if (a1 <= 0 && a2 <= 0) return;
    const size = Ti.size * u, sub = Math.round(size * 0.43);
    let x = W / 2, y = H * 0.4, align = "center";
    if (Ti.pos === "lowleft") { x = W * 0.07; y = H * 0.72; align = "left"; }
    if (Ti.pos === "top") { y = H * 0.16; }
    ctx.save();
    ctx.textAlign = align; ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 8 * u; ctx.shadowOffsetX = 2 * u; ctx.shadowOffsetY = 2 * u;
    ctx.fillStyle = Ti.color;
    ctx.globalAlpha = a1;
    ctx.font = `600 ${size}px "${Ti.font}", serif`;
    ctx.fillText(Ti.main, x, y);
    const tw = Math.max(ctx.measureText(Ti.main).width, 200 * u);
    let y2 = y + size * 0.5;
    if (Ti.line) {
      ctx.globalAlpha = a2 * 0.85;
      const lw = Math.min(W * 0.6, tw * 1.15);
      ctx.fillRect(align === "center" ? x - lw / 2 : x, y2, lw, Math.max(1, 2 * u));
      y2 += sub * 0.5;
    }
    if (Ti.sub) {
      ctx.globalAlpha = a2;
      ctx.font = `400 ${sub}px "${Ti.font}", serif`;
      ctx.fillText(Ti.sub, x, y2 + sub);
    }
    ctx.restore();
  }
  function drawCaption(text, t, od) {
    const a = fadeA(t, 0.6, od - 0.4, 0.7);
    if (a <= 0) return;
    const H = canvas.height, u = H / 1080, f = HC.state.title.font;
    ctx.save();
    ctx.globalAlpha = a * 0.92; ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 8 * u; ctx.shadowOffsetX = 2 * u; ctx.shadowOffsetY = 2 * u;
    ctx.fillStyle = "#fff"; ctx.font = `500 ${88 * u}px "${f}", serif`;
    ctx.fillText(text, canvas.width / 2, H * 0.47);
    ctx.restore();
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
    const v = vids[1 - cur];
    nextReady = load(v, s, 0).then(() => tk === token).catch(() => false);
  }

  /* ---------- 跳到某個時間（暫停狀態） ---------- */
  R.seek = async (T) => {
    R.stop();
    const tk = ++token;
    const at = HC.shotAt(T);
    if (!at) { clear(); R.T = 0; R.onTime && R.onTime(0); return; }
    const v = vids[cur], s = HC.state.shots[at.i];
    try { await load(v, s, at.off); } catch (e) { return; }
    if (tk !== token) return;
    idx = at.i; R.T = T;
    R.drawFrame(v, s, at.off, T, at.i, true);
    R.onTime && R.onTime(T);
  };

  /* ---------- 播放 ---------- */
  R.play = async (T, hooks) => {
    R.stop();
    const tk = ++token;
    const at = HC.shotAt(T);
    if (!at) return;
    const v = vids[cur], s = HC.state.shots[at.i];
    try { await load(v, s, at.off); } catch (e) { R.onError && R.onError(e); return; }
    if (tk !== token) return;
    idx = at.i; waitHooks = hooks || null;
    R.drawFrame(v, s, at.off, T, at.i);
    hooks && hooks.ready && (await hooks.ready());
    prepareNext(tk);
    playing = true;
    R.music.start(T);
    await v.play().catch(() => {});
    R.onState && R.onState(true);
    requestAnimationFrame(() => loop(tk));
  };
  R.stop = () => {
    playing = false; advancing = false;
    vids.forEach((v) => v.pause());
    R.music.stop();
    R.onState && R.onState(false);
  };
  R.isPlaying = () => playing;

  function onFrame(v, mt) {
    if (!playing || advancing || v !== vids[cur]) return;
    const s = HC.state.shots[idx];
    if (!s) return;
    const od = HC.outDur(s), lt = (mt - s.start) / s.speed;
    if (lt < 0 || lt >= od) return;
    const T = HC.timeline().starts[idx] + lt;
    R.drawFrame(v, s, lt, T, idx);
    lastDraw = performance.now();
  }
  let lastDraw = 0;

  function loop(tk) {
    if (!playing || tk !== token) return;
    const S = HC.state, s = S.shots[idx], v = vids[cur];
    if (!s) { finish(); return; }
    const od = HC.outDur(s);
    const lt = (v.currentTime - s.start) / s.speed;
    const T = HC.timeline().starts[idx] + HC.clamp(lt, 0, od);
    if (!advancing) {
      if (lt >= od - 0.017 || v.ended) advance(tk);
      else { if (!v._rvfc || performance.now() - lastDraw > 50) { R.drawFrame(v, s, Math.max(0, lt), T, idx); lastDraw = performance.now(); } R.T = T; R.music.sync(T); R.onTime && R.onTime(T); }
    }
    requestAnimationFrame(() => loop(tk));
  }
  async function advance(tk) {
    advancing = true;
    const S = HC.state;
    vids[cur].pause();
    if (idx + 1 >= S.shots.length) { finish(); return; }
    let ok = nextReady ? await withWait(nextReady) : false;
    if (tk !== token) return;
    if (!ok) {   // 沒準備好就重新載入
      ok = await withWait(load(vids[1 - cur], S.shots[idx + 1], 0).then(() => true).catch(() => false));
      if (!ok || tk !== token) { R.stop(); return; }
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
    R.music.hold(true);
    val = await p;
    R.music.hold(false);
    waitHooks && waitHooks.resume && waitHooks.resume();
    return val;
  }
  function finish() {
    const { total } = HC.timeline();
    R.stop();
    R.T = total;
    R.onTime && R.onTime(total);
    const h = waitHooks; waitHooks = null;
    h && h.done && h.done();
  }

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
    const H0 = canvas.height;
    const h = S.out.res === 720 ? 720 : 1080;
    canvas.width = h * 16 / 9; canvas.height = h;
    const stream = canvas.captureStream(30);
    if (S.music.url) for (const tr of R.music.stream().getAudioTracks()) stream.addTrack(tr);
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: S.out.rate * 1e6, audioBitsPerSecond: 192000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      canvas.width = H0 * 16 / 9; canvas.height = H0;
      R.onTime = prevOnTime;
      resolve({ blob: new Blob(chunks, { type: (mime || "video/webm").split(";")[0] }), ext: (mime || "webm").includes("mp4") ? "mp4" : "webm" });
    };
    const prevOnTime = R.onTime;
    const { total } = HC.timeline();
    R.onTime = (T) => { prevOnTime && prevOnTime(T); onProgress && onProgress(T / total); };
    R.cancelExport = () => { R.stop(); if (rec.state !== "inactive") rec.stop(); };
    await R.play(0, {
      ready: async () => { rec.start(1000); },
      pause: () => { if (rec.state === "recording") rec.pause(); },
      resume: () => { if (rec.state === "paused") rec.resume(); },
      done: () => { setTimeout(() => rec.state !== "inactive" && rec.stop(), 250); },
    });
  });
}
