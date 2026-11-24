/* 素材分析
   把影片以 4 倍速在背景播放，每 0.1 秒取一張小圖：
   - motion：畫面變化量（鏡頭有沒有在動、動得多快）
   - dx / dy：鏡頭往哪個方向移動（用來找出橫向運鏡）
   - luma：亮度（太暗的黑畫面會被避開）
   - cursor：每 0.3 秒用原尺寸畫面找一次白色滑鼠游標
   - ui：遊戲介面（快捷列、聊天框、小地圖…）。鏡頭在動的時候，畫面上還是固定不動、有紋理的區塊就是介面
*/
{
  const HC = window.HC;
  const SW = 192, SH = 108;       // 動態分析用的小圖
  const CW = 1920, CH = 1080;     // 找游標用的原尺寸畫面（游標很小，縮圖會看不到）
  /* 游標白色部分在 1080p 畫面中的大小範圍（Windows 預設游標、100% 縮放約 9×15 像素）
     如果你的 Windows 顯示縮放比較大、游標被漏掉，可以把這些數字放大 */
  HC.CURSOR = { minArea: 40, maxArea: 110, minW: 6, maxW: 12, minH: 10, maxH: 19, minRatio: 1.3, maxRatio: 2.4 };

  HC.analyzeClip = async (clip, onProgress, opts = {}) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.src = clip.url;
    await HC.once(v, "loadedmetadata", 15000);
    clip.dur = v.duration; clip.w = v.videoWidth; clip.h = v.videoHeight;

    const sc = document.createElement("canvas"); sc.width = SW; sc.height = SH;
    const sx = sc.getContext("2d", { willReadFrequently: true });
    const cc = document.createElement("canvas"); cc.width = CW; cc.height = CH;
    const cx = cc.getContext("2d", { willReadFrequently: true });

    const A = { t: [], m: [], dx: [], dy: [], luma: [], curT: [], blk: [], zm: [] };
    let prev = null, prevT = -1, lastCur = -1;

    const take = (t) => {
      sx.drawImage(v, 0, 0, SW, SH);
      const d = sx.getImageData(0, 0, SW, SH).data;
      const g = new Uint8Array(SW * SH);
      let sum = 0;
      for (let i = 0, j = 0; i < g.length; i++, j += 4) { const y = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8; g[i] = y; sum += y; }
      if (prev) {
        const dt = Math.max(0.02, t - prevT);
        let diff = 0;
        for (let i = 0; i < g.length; i += 2) diff += Math.abs(g[i] - prev[i]);
        diff /= g.length / 2;
        const sh = shift(prev, g);
        A.t.push(t); A.m.push(diff * 0.1 / dt); A.dx.push(sh[0] / dt); A.dy.push(sh[1] / dt); A.luma.push(sum / g.length);
        A.blk.push(diff > 3 ? staticBlocks(prev, g, diff) : null);   // 介面會讓位移估計變成 0，所以只看整體變化量
        if (opts.zoom) {   // 參考影片：左右兩半各估一次位移，差值 = 推近／拉遠
          const L = shift(prev, g, 20, SW / 2 - 8), Rr = shift(prev, g, SW / 2 + 8, SW - 20);
          A.zm.push(((Rr[0] - L[0]) / (SW / 2)) / dt);
        }
      }
      prev = g; prevT = t;
      if (t - lastCur >= 0.3) {
        lastCur = t;
        cx.drawImage(v, 0, 0, CW, CH);
        if (HC.findCursor(cx.getImageData(0, 0, CW, CH))) A.curT.push(t);
      }
      onProgress && onProgress(Math.min(1, t / clip.dur));
    };

    let ok = false;
    if ("requestVideoFrameCallback" in v) ok = await viaFrames(v, take, clip.dur);
    if (!ok) { A.t.length = A.m.length = A.dx.length = A.dy.length = A.luma.length = A.curT.length = A.blk.length = A.zm.length = 0; prev = null; lastCur = -1; await viaSeek(v, take, clip.dur); }

    A.cursor = ranges(A.curT, 0.6, 0.45);
    HC.findUI(A);
    if (!HC.debugUI) delete A.blk;
    clip.ana = A;
    v.removeAttribute("src"); v.load();
    return A;
  };

  /* 快速：4 倍速播放並在每個解碼出的畫面取樣 */
  function viaFrames(v, take, dur) {
    return new Promise((res) => {
      let last = -1, done = false, watchdog;
      const finish = (ok) => { if (done) return; done = true; clearInterval(watchdog); v.pause(); res(ok); };
      let lastSeen = performance.now();
      const cb = (now, meta) => {
        if (done) return;
        lastSeen = performance.now();
        const t = meta.mediaTime;
        if (t - last >= 0.1) { take(t); last = t; }
        if (t >= dur - 0.08) return finish(true);
        v.requestVideoFrameCallback(cb);
      };
      v.addEventListener("ended", () => setTimeout(() => finish(last > dur * 0.8), 50), { once: true });
      watchdog = setInterval(() => { if (performance.now() - lastSeen > 4000) finish(last > dur * 0.8); }, 1000);
      v.requestVideoFrameCallback(cb);
      v.playbackRate = 4;
      v.play().catch(() => finish(false));
    });
  }
  /* 備用：逐格跳轉（較慢，但在任何瀏覽器都能用） */
  async function viaSeek(v, take, dur) {
    for (let t = 0.05; t < dur - 0.05; t += 0.2) {
      v.currentTime = t;
      try { await HC.once(v, "seeked"); } catch (e) { continue; }
      take(t);
    }
  }

  /* 估計兩張小圖之間的平移量（像素），回傳 [dx, dy]：畫面內容往右移為正 */
  function shift(a, b, x0 = 20, x1 = SW - 20) {
    let best = Infinity, bx = 0, by = 0;
    const R = 9, RY = 6, y0 = 14, y1 = SH - 14;
    for (let oy = -RY; oy <= RY; oy++) for (let ox = -R; ox <= R; ox++) {
      let s = 0;
      for (let y = y0; y < y1; y += 2) {
        const ra = y * SW, rb = (y + oy) * SW + ox;
        for (let x = x0; x < x1; x += 2) s += Math.abs(a[ra + x] - b[rb + x]);
        if (s >= best) break;
      }
      if (s < best) { best = s; bx = ox; by = oy; }
    }
    return [bx, by];
  }

  /* ---------- 遊戲介面偵測 ----------
     把小圖切成 8×8 的格子。鏡頭明顯在移動時，記下「完全沒變、但有圖案」的格子。
     同一批格子在大部分移動畫面裡都不動 → 那裡蓋著介面。畫面正中央（角色常站的位置）不列入。 */
  const BS = 8, BX = Math.floor(SW / BS), BY = Math.floor(SH / BS);
  HC.UI = { minBlocks: 3, persist: 0.15, minHits: 6, center: [0.28, 0.72, 0.18, 0.92] };   // 介面偵測的靈敏度
  function staticBlocks(a, b, diff) {
    const lim = Math.max(1.2, Math.min(4, diff * 0.2));   // 比整體變化小很多就算「沒動」（半透明介面底下的背景還是會動一點）
    const out = new Uint8Array(BX * BY);
    const [cx0, cx1, cy0, cy1] = HC.UI.center;
    for (let by = 0; by < BY; by++) for (let bx = 0; bx < BX; bx++) {
      const fx = (bx + 0.5) / BX, fy = (by + 0.5) / BY;
      if (fx > cx0 && fx < cx1 && fy > cy0 && fy < cy1) continue;
      let d = 0, s = 0, s2 = 0;
      for (let y = by * BS; y < by * BS + BS; y++) for (let x = bx * BS; x < bx * BS + BS; x++) {
        const i = y * SW + x; d += Math.abs(a[i] - b[i]); s += b[i]; s2 += b[i] * b[i];
      }
      const n = BS * BS, sd = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
      if (d / n < lim && sd > 8) out[by * BX + bx] = 1;
    }
    return out;
  }
  HC.findUI = (A) => {
    const n = A.t.length, U = HC.UI;
    const moving = A.blk.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
    A.uiFlag = new Array(n).fill(false);
    A.ui = [];
    if (moving.length < 4) return;
    // 每個格子在移動畫面裡「不動」的比例
    const hits = new Float32Array(BX * BY);
    for (const i of moving) { const b = A.blk[i]; for (let k = 0; k < b.length; k++) hits[k] += b[k]; }
    const persistent = new Uint8Array(BX * BY);
    for (let k = 0; k < hits.length; k++) persistent[k] = hits[k] >= Math.max(U.minHits, moving.length * U.persist) ? 1 : 0;
    // 每個移動中的取樣：落在「固定格子」上的不動格數
    for (const i of moving) {
      const b = A.blk[i]; let c = 0;
      for (let k = 0; k < b.length; k++) if (b[k] && persistent[k]) c++;
      A.uiFlag[i] = c >= U.minBlocks;
    }
    // 靜止的取樣看不出來，沿用前後 4 秒內最近的移動取樣
    for (let i = 0; i < n; i++) {
      if (A.blk[i]) continue;
      let best = null, bd = 4;
      for (const j of moving) { const d = Math.abs(A.t[j] - A.t[i]); if (d < bd) { bd = d; best = j; } }
      if (best != null) A.uiFlag[i] = A.uiFlag[best];
    }
    // 連成區間（少於 3 個取樣的視為雜訊）
    let s0 = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && A.uiFlag[i];
      if (on && s0 < 0) s0 = i;
      if (!on && s0 >= 0) { if (i - s0 >= 2) A.ui.push([Math.max(0, A.t[s0] - 0.3), A.t[i - 1] + 0.3]); s0 = -1; }
    }
    // 相隔不到 2.5 秒的介面區間接起來（介面通常是一直開著的）
    const merged = [];
    for (const r of A.ui) { if (merged.length && r[0] - merged[merged.length - 1][1] < 2.5) merged[merged.length - 1][1] = r[1]; else merged.push(r); }
    A.ui = merged;
    A.uiBlocks = Array.from(persistent);
  };

  /* 時間點合併成區間 */
  function ranges(ts, gap, pad) {
    const out = [];
    for (const t of ts) {
      if (out.length && t - out[out.length - 1][1] <= gap) out[out.length - 1][1] = t;
      else out.push([t, t]);
    }
    return out.map(([a, b]) => [Math.max(0, a - pad), b + pad]);
  }

  /* 找白色箭頭游標：白色小塊、外圈是深色描邊、尖端在左上、形狀細長 */
  HC.findCursor = (img) => {
    const { data, width: W, height: H } = img;
    const white = new Uint8Array(W * H);
    let count = 0;
    for (let i = 0, j = 0; i < white.length; i++, j += 4) {
      if (data[j] > 222 && data[j + 1] > 222 && data[j + 2] > 222) { white[i] = 1; count++; }
    }
    if (!count || count > W * H * 0.2) return false;
    const seen = new Uint8Array(W * H);
    const stack = [];
    for (let p = 0; p < white.length; p++) {
      if (!white[p] || seen[p]) continue;
      let area = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
      const pix = [];
      stack.push(p); seen[p] = 1;
      while (stack.length) {
        const q = stack.pop(); area++;
        const x = q % W, y = (q / W) | 0;
        if (area <= 400) pix.push(q);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && white[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack.push(q - 1); }
        if (x < W - 1 && white[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack.push(q + 1); }
        if (y > 0 && white[q - W] && !seen[q - W]) { seen[q - W] = 1; stack.push(q - W); }
        if (y < H - 1 && white[q + W] && !seen[q + W]) { seen[q + W] = 1; stack.push(q + W); }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const K = HC.CURSOR;
      if (area < K.minArea || area > K.maxArea || w < K.minW || w > K.maxW || h < K.minH || h > K.maxH) continue;
      const ratio = h / w, fill = area / (w * h);
      if (ratio < K.minRatio || ratio > K.maxRatio || fill < 0.35 || fill > 0.72) continue;
      // 尖端：最上面一列很窄，而且靠左
      let topMin = W, topMax = -1;
      for (const q of pix) if (((q / W) | 0) === y0) { const x = q % W; if (x < topMin) topMin = x; if (x > topMax) topMax = x; }
      if (topMax - topMin > 2 || topMin - x0 > 1) continue;
      // 左邊緣大致是直的（箭頭的左側）
      let leftHits = 0;
      for (let y = y0; y <= y0 + Math.floor(h * 0.6); y++) { const q = y * W + x0; if (white[q] || white[q + 1]) leftHits++; }
      if (leftHits < Math.floor(h * 0.6) * 0.75) continue;
      // 外圈要夠暗（游標的黑色描邊）
      let dark = 0, ring = 0;
      for (const q of pix) {
        const x = q % W, y = (q / W) | 0;
        for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (white[n]) continue;
          ring++;
          // 游標描邊常有一圈反鋸齒灰邊，所以看相鄰兩格，其中一格夠暗就算
          const j = n * 4;
          const n2x = HC.clamp(nx + ox, 0, W - 1), n2y = HC.clamp(ny + oy, 0, H - 1), j2 = (n2y * W + n2x) * 4;
          if (Math.min(data[j] + data[j + 1] + data[j + 2], data[j2] + data[j2 + 1] + data[j2 + 2]) < 450) dark++;
        }
      }
      if (ring && dark / ring > 0.65) return true;
    }
    return false;
  };
}
