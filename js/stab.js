/* 防抖
   1. 把鏡頭那一段影片逐格取出，比對前後兩格，算出畫面每一格往哪裡偏了多少（鏡頭軌跡）
   2. 把軌跡做平滑處理：保留你本來的平移、轉動，只去掉手抖的小晃動
   3. 播放時把畫面稍微放大，再往反方向挪一點，抵銷晃動
   只處理平移晃動（左右上下），鏡頭轉動造成的透視變化不會被修正。
*/
{
  const HC = window.HC;
  const cache = new Map();          // key -> {t, x, y}（原始素材時間、以畫面寬高為單位的累積位移）；失敗 = null
  const fails = new Map();          // key -> {n: 連續失敗次數, at: 最後失敗時間}
  const MAX_CACHE = 300;            // 最多記住幾段的量測結果，超過就丟掉時間軸上已經沒用到的
  const RETRY = 3, RETRY_AFTER = 30000;   // 失敗立刻重試 3 次；還是失敗，30 秒後再按播放或匯出會重新試
  const jobs = [];
  let running = false;
  const FW = 640, FH = 360;       // 量測用的畫面大小（越大越準、越慢）
  HC.STAB_RATE = 0.5;             // 量測時的播放速度：太快會漏格

  HC.stabKey = (s) => `${s.clipId}|${s.start.toFixed(2)}|${s.dur.toFixed(2)}`;
  HC.stabReady = (s) => cache.has(HC.stabKey(s));
  HC.stabFailed = (s) => cache.has(HC.stabKey(s)) && cache.get(HC.stabKey(s)) === null;
  function remember(k, val) {
    cache.delete(k); cache.set(k, val);
    if (cache.size <= MAX_CACHE) return;
    const used = new Set(HC.state.shots.filter((s) => s.stab).map(HC.stabKey));
    for (const key of cache.keys()) { if (cache.size <= MAX_CACHE) break; if (!used.has(key)) cache.delete(key); }
  }
  HC.stabPending = () => jobs.length + (running ? 1 : 0);

  /* 需要防抖但還沒分析的鏡頭排進佇列 */
  HC.stabQueue = (onDone) => {
    for (const s of HC.state.shots) {
      if (!s.stab) continue;
      const k = HC.stabKey(s), c = HC.clip(s.clipId);
      if (!c || c.missing || jobs.some((j) => j.k === k)) continue;
      if (cache.has(k)) {   // 之前失敗過：隔一段時間再試
        const f = fails.get(k);
        if (cache.get(k) !== null || !f || Date.now() - f.at < RETRY_AFTER) continue;
        cache.delete(k); f.n = 0;
      }
      jobs.push({ k, clip: c, a: s.start, b: s.start + s.dur });
    }
    pump(onDone);
  };
  HC.stabWaitAll = (onProgress) => new Promise((res) => {
    HC.stabQueue();
    let total = Math.max(1, HC.stabPending());
    const tick = () => {
      const left = HC.stabPending();
      total = Math.max(total, left);
      onProgress && onProgress(1 - left / total);
      if (!left) res(); else setTimeout(tick, 300);
    };
    tick();
  });

  let onAnyDone = null;
  async function pump(onDone) {
    if (onDone) onAnyDone = onDone;
    if (running) return;
    running = true;
    while (jobs.length) {
      const j = jobs.shift();
      try {
        const r = await measure(j.clip, j.a, j.b);
        if (r.t.length < 4) throw new Error("too few frames");
        remember(j.k, r); fails.delete(j.k);
      } catch (e) {
        const f = fails.get(j.k) || { n: 0, at: 0 };
        f.n++; f.at = Date.now(); fails.set(j.k, f);
        if (f.n < RETRY && j.clip.url && !j.clip.missing) jobs.push(j);   // 排到最後再試一次
        else remember(j.k, null);   // 先當作不防抖，免得播放、匯出一直等
      }
      onAnyDone && onAnyDone();
    }
    running = false;
  }

  /* 逐格量測位移 */
  /* 一般 MP4：直接依序解碼，不用慢速播放（快很多） */
  async function measureDecode(clip, a, b) {
    const ix = clip.file && HC.mp4Index ? await HC.mp4Index(clip.file).catch(() => null) : null;
    if (!ix) return null;
    const from = Math.max(0, a - 0.4), to = b + 0.4;
    const cv = document.createElement("canvas"); cv.width = FW; cv.height = FH;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingQuality = "high";
    const T = [], X = [], Y = [], src = HC.decodeSource(clip.file, ix, from);
    let prev = null, px = 0, py = 0;
    try {
      for (;;) {
        const fr = await src.nextFrame();
        if (!fr) break;
        const t = fr.timestamp / 1e6;
        if (t < from - 1e-3) continue;
        if (t > to) break;
        cx.drawImage(fr, 0, 0, FW, FH);
        const d = cx.getImageData(0, 0, FW, FH).data, g = new Float32Array(FW * FH);
        for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11;
        if (prev) { const [dx, dy] = shiftPyramid(prev, g); px += dx; py += dy; }
        prev = g;
        T.push(t); X.push(px / FW); Y.push(py / FH);
      }
    } finally { src.close(); }
    return T.length >= 4 ? { t: Float64Array.from(T), x: Float64Array.from(X), y: Float64Array.from(Y) } : null;
  }

  async function measure(clip, a, b) {
    const fast = await measureDecode(clip, a, b).catch(() => null);
    if (fast) return fast;
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = clip.url;
    await HC.once(v, "loadeddata", 15000);
    const from = Math.max(0, a - 0.4), to = Math.min(v.duration, b + 0.4);
    v.currentTime = from;
    await HC.once(v, "seeked");
    const cv = document.createElement("canvas"); cv.width = FW; cv.height = FH;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingQuality = "high";   // 縮小時用較好的濾波，避免細節疊影
    const T = [], X = [], Y = [];
    let prev = null, px = 0, py = 0, lastT = -1;
    const grab = (t) => {
      cx.drawImage(v, 0, 0, FW, FH);
      const d = cx.getImageData(0, 0, FW, FH).data, g = new Float32Array(FW * FH);
      for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11;
      if (prev) { const [dx, dy] = shiftPyramid(prev, g); px += dx; py += dy; }
      prev = g;
      T.push(t); X.push(px / FW); Y.push(py / FH);
    };
    // 慢速播放，每一格出現時立刻取圖（不暫停、不跳轉，畫面和時間才對得上）
    if ("requestVideoFrameCallback" in v) {
      await new Promise((res) => {
        let done = false;
        const fin = () => { if (!done) { done = true; v.pause(); res(); } };
        const cb = (now, meta) => {
          const t = meta.mediaTime;
          if (t > lastT + 0.001) { grab(t); lastT = t; }
          if (t >= to) return fin();
          v.requestVideoFrameCallback(cb);
        };
        v.requestVideoFrameCallback(cb);
        v.addEventListener("ended", fin, { once: true });
        setTimeout(fin, (to - from) / HC.STAB_RATE * 1000 + 8000);
        v.playbackRate = HC.STAB_RATE;
        v.play().catch(fin);
      });
    }
    if (T.length < 4) {   // 備用：逐格跳轉
      T.length = X.length = Y.length = 0; prev = null; px = py = 0;
      for (let t = from; t <= to; t += 1 / 30) { v.currentTime = t; try { await HC.once(v, "seeked"); } catch (e) { continue; } grab(t); }
    }
    v.removeAttribute("src"); v.load();
    return { t: Float64Array.from(T), x: Float64Array.from(X), y: Float64Array.from(Y) };
  }

  /* 量位移（兩段式）：
     1. 相位相關法：把畫面縮成 256×128 做 FFT，找出整體位移的大方向（對前後景移動速度不同的畫面比較穩）
     2. 回到 640×360，在那個位移附近逐點比對細找，再用拋物線取到小數點（比較精準）
     比對時跳過畫面正中央，因為角色通常站在那裡、會跟著鏡頭走 */
  const PW = 256, PH = 128;
  const hann = new Float32Array(PW * PH);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) hann[y * PW + x] = (0.5 - 0.5 * Math.cos(2 * Math.PI * x / (PW - 1))) * (0.5 - 0.5 * Math.cos(2 * Math.PI * y / (PH - 1)));
  function fft1(re, im, n, off, stride) {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const a = off + i * stride, b = off + j * stride; [re[a], re[b]] = [re[b], re[a]]; [im[a], im[b]] = [im[b], im[a]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = off + (i + k) * stride, b = off + (i + k + len / 2) * stride;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }
  function fft2(re, im, inv) {
    if (inv) for (let i = 0; i < im.length; i++) im[i] = -im[i];
    for (let y = 0; y < PH; y++) fft1(re, im, PW, y * PW, 1);
    for (let x = 0; x < PW; x++) fft1(re, im, PH, x, PW);
    if (inv) for (let i = 0; i < im.length; i++) im[i] = -im[i];
  }
  function spectrum(g) {   // g 是 640×360 灰階
    const re = new Float32Array(PW * PH), im = new Float32Array(PW * PH);
    // 用區域平均縮小（直接跳點取樣會讓樹葉這類細節產生疊影，量錯位移）
    for (let y = 0; y < PH; y++) {
      const y0 = Math.floor(y * FH / PH), y1 = Math.max(y0 + 1, Math.floor((y + 1) * FH / PH));
      for (let x = 0; x < PW; x++) {
        const x0 = Math.floor(x * FW / PW), x1 = Math.max(x0 + 1, Math.floor((x + 1) * FW / PW));
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += g[yy * FW + xx];
        re[y * PW + x] = sum / ((y1 - y0) * (x1 - x0)) * hann[y * PW + x];
      }
    }
    fft2(re, im, false);
    return { re, im };
  }
  function phaseShift(A, B) {
    const re = new Float32Array(PW * PH), im = new Float32Array(PW * PH);
    for (let i = 0; i < re.length; i++) {
      const r = B.re[i] * A.re[i] + B.im[i] * A.im[i], c = B.im[i] * A.re[i] - B.re[i] * A.im[i], m = Math.hypot(r, c) + 1e-6;
      re[i] = r / m; im[i] = c / m;
    }
    fft2(re, im, true);
    let bi = 0;
    for (let i = 1; i < re.length; i++) if (re[i] > re[bi]) bi = i;
    // 峰值附近 5×5 取加權中心，算到小數點（跟 OpenCV 的做法一樣）
    const cx0 = bi % PW, cy0 = (bi / PW) | 0;
    let sw = 0, sx = 0, sy = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = (cx0 + dx + PW) % PW, y = (cy0 + dy + PH) % PH, v = Math.max(0, re[y * PW + x]);
      sw += v; sx += v * dx; sy += v * dy;
    }
    let px = cx0 + (sw ? sx / sw : 0), py = cy0 + (sw ? sy / sw : 0);
    if (px > PW / 2) px -= PW; if (py > PH / 2) py -= PH;
    return [px * FW / PW, py * FH / PH];
  }
  const inCenter = (fx, fy) => fx > 0.3 && fx < 0.7 && fy > 0.25 && fy < 0.85;
  function refine(a, b, cx, cy) {
    const mx = 60, my = 44, res = {}, R = 4;
    cx = HC.clamp(Math.round(cx), -mx + R + 1, mx - R - 1); cy = HC.clamp(Math.round(cy), -my + R + 1, my - R - 1);
    let best = Infinity, bx = cx, by = cy;
    for (let oy = cy - R; oy <= cy + R; oy++) for (let ox = cx - R; ox <= cx + R; ox++) {
      let sum = 0, n = 0;
      for (let y = my; y < FH - my; y += 3) {
        const ra = y * FW, rb = (y + oy) * FW + ox, fy = y / FH;
        for (let x = mx; x < FW - mx; x += 3) { if (inCenter(x / FW, fy)) continue; sum += Math.abs(a[ra + x] - b[rb + x]); n++; }
      }
      res[ox + "," + oy] = sum / n;
      if (sum / n < best) { best = sum / n; bx = ox; by = oy; }
    }
    const sub = (m, c, p) => (m == null || p == null) ? 0 : HC.clamp((m - p) / (2 * (m - 2 * c + p) || 1), -0.5, 0.5);
    return [bx + sub(res[(bx - 1) + "," + by], best, res[(bx + 1) + "," + by]), by + sub(res[bx + "," + (by - 1)], best, res[bx + "," + (by + 1)])];
  }
  let prevSpec = null;
  function shiftPyramid(a, b) {
    const sb = spectrum(b), sa = prevSpec && prevSpec.g === a ? prevSpec.s : spectrum(a);
    prevSpec = { g: b, s: sb };
    const [px, py] = phaseShift(sa, sb);
    return refine(a, b, px, py);
  }

  /* 取得某個原始時間點要補償的位移（以畫面寬高為單位） */
  HC.stabOffset = (s, mt) => {
    const d = cache.get(HC.stabKey(s));
    if (!d || d.t.length < 3) return null;
    const sig = 0.25 + (s.stabStr ?? 0.6) * 1.25;     // 平滑程度（秒）
    if (!d.smooth || d.sig !== sig) smoothPath(d, sig);
    const t = d.t;
    let i = 0, j = t.length - 1;
    if (mt <= t[0]) i = j = 0; else if (mt >= t[j]) i = j;
    else { while (j - i > 1) { const m = (i + j) >> 1; if (t[m] <= mt) i = m; else j = m; } }
    const f = i === j ? 0 : (mt - t[i]) / (t[j] - t[i]);
    const lerp = (arr) => arr[i] + (arr[j] - arr[i]) * f;
    return [lerp(d.cx), lerp(d.cy)];
  };
  function smoothPath(d, sig) {
    const n = d.t.length, cx = new Float64Array(n), cy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, w = 0;
      for (let j = Math.max(0, i - 200); j < Math.min(n, i + 200); j++) {
        const dt = d.t[j] - d.t[i];
        if (Math.abs(dt) > sig * 3) continue;
        const k = Math.exp(-(dt * dt) / (2 * sig * sig));
        sx += d.x[j] * k; sy += d.y[j] * k; w += k;
      }
      // 輕微平滑（去掉量測雜訊）減去大幅平滑（保留你本來的運鏡）= 要抵銷的手抖
      let lx = 0, ly = 0, lw = 0;
      for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) { const dt = d.t[j] - d.t[i], k = Math.exp(-(dt * dt) / (2 * 0.03 * 0.03)); lx += d.x[j] * k; ly += d.y[j] * k; lw += k; }
      cx[i] = lx / lw - sx / w; cy[i] = ly / lw - sy / w;
    }
    d.cx = cx; d.cy = cy; d.smooth = true; d.sig = sig;
  }

  /* 防抖需要的放大倍率：強度越高、放大越多 */
  HC.stabCrop = (s) => 1.04 + (s.stabStr ?? 0.6) * 0.08;
}
