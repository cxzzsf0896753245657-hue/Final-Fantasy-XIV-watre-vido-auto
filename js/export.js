/* 逐格匯出（預設）
   不是邊播放邊錄，而是一格一格來：把素材跳到這一格該有的時間 → 畫好 → 交給瀏覽器內建的編碼器（WebCodecs）
   → 用 mp4-muxer／webm-muxer 包成影片檔。電腦再忙也不會掉格或重複格，只是會比較慢。
   取畫面有兩種方式：
   - 快：一般 MP4（H.264）直接讀檔案目錄、依序解碼（mp4index.js），不用跳轉
   - 備用：其他格式用 <video> 每格跳轉（要從關鍵格重新解碼，比較慢）
   背景音樂也是先離線算好（音量、淡入淡出），再編碼進去。
   瀏覽器不支援 WebCodecs（例如舊版 Safari、Firefox）時，介面會改用即時錄製。
*/
{
  const HC = window.HC, R = HC.R;
  const SR = 48000;

  HC.canFrameExport = () => typeof window.VideoEncoder === "function" && typeof window.VideoFrame === "function" && !!(window.Mp4Muxer || window.WebMMuxer);

  /* 挑這台電腦能用的編碼格式：先試 MP4（H.264），不行再用 WebM（VP9／VP8） */
  async function pickVideo(W, H, fps, bitrate) {
    const tries = [];
    if (window.Mp4Muxer) for (const c of ["avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42e028"]) tries.push({ box: "mp4", codec: c, mux: "avc" });
    if (window.WebMMuxer) { tries.push({ box: "webm", codec: "vp09.00.40.08", mux: "V_VP9" }); tries.push({ box: "webm", codec: "vp8", mux: "V_VP8" }); }
    for (const t of tries) {
      const config = { codec: t.codec, width: W, height: H, bitrate, framerate: fps, latencyMode: "quality" };
      if (t.box === "mp4") config.avc = { format: "avc" };
      try { const r = await VideoEncoder.isConfigSupported(config); if (r.supported) return { ...t, config: r.config }; } catch (e) {}
    }
    return null;
  }
  async function pickAudio(box) {
    if (typeof window.AudioEncoder !== "function") return null;
    const list = box === "mp4" ? [["mp4a.40.2", "aac"], ["opus", "opus"]] : [["opus", "A_OPUS"]];
    for (const [codec, mux] of list) {
      const config = { codec, sampleRate: SR, numberOfChannels: 2, bitrate: 192000 };
      try { const r = await AudioEncoder.isConfigSupported(config); if (r.supported) return { codec, mux, config: r.config }; } catch (e) {}
    }
    return null;
  }

  /* 背景音樂 + 環境音效：離線混好整段（音樂的起點偏移、音量、淡入淡出；環境音效循環） */
  async function renderMusic(total) {
    const M = HC.state.music, A = HC.state.amb;
    if (!M.url && !A.length) return null;
    const len = Math.ceil(total * SR), oc = new OfflineAudioContext(2, len, SR);
    const decode = async (url) => new OfflineAudioContext(2, 1, SR).decodeAudioData(await (await fetch(url)).arrayBuffer());
    const N = Math.max(2, Math.ceil(total / 0.05));
    const add = (buf, levelAt, offset, loop, at = 0) => {
      const src = oc.createBufferSource(); src.buffer = buf; src.loop = loop;
      const g = oc.createGain(), curve = new Float32Array(N);
      for (let i = 0; i < N; i++) curve[i] = levelAt((i / (N - 1)) * total);
      g.gain.setValueCurveAtTime(curve, 0, total);
      src.connect(g); g.connect(oc.destination);
      src.start(Math.max(0, at), offset);
    };
    if (M.url) { const b = await decode(M.url); add(b, (T) => R.music.level(T), Math.min(M.off, Math.max(0, b.duration - 0.01)), false, M.at || 0); }
    for (const a of A) { try { add(await decode(a.url), (T) => R.music.ambLevel(a, T), 0, true, a.start || 0); } catch (e) {} }
    return oc.startRendering();
  }

  /* 備用的畫面來源：<video> 跳到指定時間，等畫面真的換好 */
  function seekSource(clip) {
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto";
    let ready = null;
    return {
      kind: "seek",
      async frameAt(t) {
        if (!ready) { v.src = clip.url; ready = HC.once(v, "loadeddata", 20000); }
        await ready;
        t = HC.clamp(t, 0, (v.duration || 1e9) - 0.02);
        if (Math.abs(v.currentTime - t) >= 0.0005 || v.seeking) { v.currentTime = t; await HC.once(v, "seeked", 20000); }
        return v;
      },
      close() { v.removeAttribute("src"); v.load(); },
    };
  }
  /* 每支素材的檔案目錄只讀一次 */
  async function indexOf(clip) {
    if (!clip.file) return null;
    if (clip._ix === undefined) clip._ix = HC.mp4Index ? HC.mp4Index(clip.file).catch(() => null) : Promise.resolve(null);
    return clip._ix;
  }
  async function openSource(clip, from) {
    const ix = await indexOf(clip);
    if (ix) { const s = HC.decodeSource(clip.file, ix, from); s.kind = "decode"; return s; }
    return seekSource(clip);
  }

  /* ---------- 流暢預覽：做一份 640×360、每 0.5 秒一個關鍵格的代理檔（跳轉、播放都輕很多） ---------- */
  HC.makeProxy = async (clip, onProgress) => {
    if (!clip.file || !window.Mp4Muxer || typeof VideoEncoder !== "function") return false;
    const ix = await HC.mp4Index(clip.file).catch(() => null);
    if (!ix) return false;
    const W = 640, H = 360, cfg = { codec: "avc1.42e01e", width: W, height: H, bitrate: 1.2e6, framerate: 30, avc: { format: "avc" } };
    try { if (!(await VideoEncoder.isConfigSupported(cfg)).supported) return false; } catch (e) { return false; }
    const target = new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({ target, fastStart: "in-memory", firstTimestampBehavior: "offset", video: { codec: "avc", width: W, height: H } });
    let fail = null;
    const enc = new VideoEncoder({ output: (ch, meta) => muxer.addVideoChunk(ch, meta), error: (e) => { fail = e; } });
    enc.configure(cfg);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const cx = cv.getContext("2d");
    const src = HC.decodeSource(clip.file, ix, 0);
    let first = null, lastKey = -1e9, n = 0;
    try {
      for (;;) {
        const fr = await src.nextFrame();
        if (!fr || fail) break;
        const t = fr.timestamp / 1e6;
        if (first == null) first = t;
        cx.drawImage(fr, 0, 0, W, H);
        const vf = new VideoFrame(cv, { timestamp: Math.round((t - first) * 1e6) });
        const key = t - lastKey >= 0.5; if (key) lastKey = t;
        enc.encode(vf, { keyFrame: key }); vf.close();
        while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
        if (++n % 30 === 0) { onProgress && onProgress(Math.min(1, t / (clip.dur || 1))); await new Promise((r) => setTimeout(r, 0)); }
      }
      await enc.flush();
      if (fail) throw fail;
      muxer.finalize();
    } finally { src.close(); try { enc.close(); } catch (e) {} }
    clip.proxyUrl = URL.createObjectURL(new Blob([target.buffer], { type: "video/mp4" }));
    clip.proxyShift = first || 0;
    return true;
  };

  R.exportFrames = async (onProgress, isCancelled) => {
    const S = HC.state, canvas = R.canvas();
    const fps = S.out.fps || 30, { W, H } = HC.outSize();
    const { starts, total } = HC.timeline();
    const vc = await pickVideo(W, H, fps, S.out.rate * 1e6);
    if (!vc) throw new Error("這個瀏覽器沒有可用的影片編碼器，請改用「即時錄製」");
    let audio = null, ac = null;
    if (R.music.has()) {
      ac = await pickAudio(vc.box);
      if (ac) audio = await renderMusic(total);
    }
    const Mux = vc.box === "mp4" ? window.Mp4Muxer : window.WebMMuxer;
    const target = new Mux.ArrayBufferTarget();
    const muxer = new Mux.Muxer(vc.box === "mp4"
      ? { target, fastStart: "in-memory", firstTimestampBehavior: "offset", video: { codec: "avc", width: W, height: H, frameRate: fps }, ...(audio ? { audio: { codec: ac.mux, sampleRate: SR, numberOfChannels: 2 } } : {}) }
      : { target, firstTimestampBehavior: "offset", video: { codec: vc.mux, width: W, height: H, frameRate: fps }, ...(audio ? { audio: { codec: ac.mux, sampleRate: SR, numberOfChannels: 2 } } : {}) });
    let fail = null;
    const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { fail = e; } });
    venc.configure(vc.config);
    const aenc = audio ? new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { fail = e; } }) : null;
    if (aenc) aenc.configure(ac.config);

    R.stop();
    R.exporting = true;
    const W0 = canvas.width, H0 = canvas.height;
    canvas.width = W; canvas.height = H;
    const open = new Map();   // 鏡頭編號 -> 畫面來源（同時最多兩個：轉場時前後兩個鏡頭）
    const used = { decode: 0, seek: 0 };
    const frames = Math.max(1, Math.round(total * fps));
    const t0 = performance.now();
    try {
      // 音樂先全部送進編碼器（很快）
      if (aenc) {
        const CH = 4096, L = audio.length, c0 = audio.getChannelData(0), c1 = audio.getChannelData(1);
        for (let i = 0; i < L; i += CH) {
          const n = Math.min(CH, L - i), data = new Float32Array(n * 2);
          data.set(c0.subarray(i, i + n), 0); data.set(c1.subarray(i, i + n), n);
          const ad = new AudioData({ format: "f32-planar", sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / SR * 1e6), data });
          aenc.encode(ad); ad.close();
        }
      }
      for (let n = 0; n < frames; n++) {
        if (isCancelled && isCancelled()) throw Object.assign(new Error("cancelled"), { cancelled: true });
        if (fail) throw fail;
        const T = Math.min(n / fps, total - 1e-3), at = HC.shotAt(T);
        if (!at) continue;
        const sh = S.shots, src = (i, lt) => HC.srcTime(sh[i], lt);
        const need = at.overlap ? [at.i - 1, at.i] : [at.i];
        for (const [i, s] of open) if (!need.includes(typeof i === "number" ? i : +String(i).split(":")[0])) { s.close(); open.delete(i); }
        for (const i of need) if (!open.has(i)) {
          const c = HC.clip(sh[i].clipId);
          if (!c || c.missing || !c.url) throw new Error("缺少素材：" + (c ? c.name : ""));
          const s = await openSource(c, sh[i].start); open.set(i, s); used[s.kind]++;
        }
        // 日夜對比、子母畫面用到的其他素材
        const ex = new Map();
        for (const i of need) {
          const lt = i === at.i ? at.off : T - starts[i];
          for (const [kind, ref] of HC.exSpecs(sh[i])) {
            const key = i + ":" + kind, c = HC.clip(ref.clipId);
            if (!c || !c.url) continue;
            if (!open.has(key)) { const s2 = await openSource(c, ref.start); open.set(key, s2); used[s2.kind]++; }
            ex.set(sh[i].id + ":" + kind, await open.get(key).frameAt(HC.clamp(ref.start + lt * sh[i].speed, 0, (c.dur || 1e9) - 0.05)));
          }
        }
        R.exOverride = ex;
        if (at.overlap) {
          const p = at.i - 1, plt = T - starts[p];
          const [a, b] = await Promise.all([open.get(p).frameAt(src(p, plt)), open.get(at.i).frameAt(src(at.i, at.off))]);
          R.compose(T, a, p, plt, b, at.i, at.off, false);
        } else {
          const a = await open.get(at.i).frameAt(src(at.i, at.off));
          R.compose(T, a, at.i, at.off, null, null, null, false);
        }
        const fr = new VideoFrame(canvas, { timestamp: Math.round(n * 1e6 / fps), duration: Math.round(1e6 / fps) });
        venc.encode(fr, { keyFrame: n % (fps * 2) === 0 });
        fr.close();
        while (venc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
        if (n % 3 === 0) {
          const el = (performance.now() - t0) / 1000, p = (n + 1) / frames;
          onProgress && onProgress(p, el / p - el);
          R.onTime && R.onTime(T);
        }
      }
      await venc.flush();
      if (aenc) await aenc.flush();
      if (fail) throw fail;
      muxer.finalize();
      onProgress && onProgress(1, 0);
      return { blob: new Blob([target.buffer], { type: vc.box === "mp4" ? "video/mp4" : "video/webm" }), ext: vc.box, codec: vc.codec, secs: (performance.now() - t0) / 1000, used };
    } finally {
      try { venc.state !== "closed" && venc.close(); } catch (e) {}
      try { aenc && aenc.state !== "closed" && aenc.close(); } catch (e) {}
      for (const s of open.values()) s.close();
      R.exOverride = null;
      canvas.width = W0; canvas.height = H0;
      R.exporting = false;
    }
  };
}
