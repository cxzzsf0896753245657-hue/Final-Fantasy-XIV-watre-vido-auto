/* 音樂拍點
   1. 把音樂解碼成單聲道 22 kHz，每 11.6 毫秒算一次「頻譜突然變強的程度」（onset）
   2. 用自相關找出速度（BPM，偏好 70～160）
   3. 動態規劃找出最像拍點的一串時間（Ellis 2007 的 beat tracking），每 4 拍當一小節
   4. 自動剪輯（或按「對齊拍點」）時，把每個剪接點挪到最近的拍點上
*/
{
  const HC = window.HC;
  const SR = 22050, N = 1024, HOP = 256, FPS = SR / HOP;
  let info = null;   // { beats:[音樂秒數], bars:[...], bpm }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const p = i + j, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
          re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  /* 偵測拍點；傳 null 表示清除 */
  HC.analyzeBeats = async (file) => {
    info = null;
    if (!file) return null;
    try {
      const buf = await new OfflineAudioContext(1, 1, SR).decodeAudioData(await file.arrayBuffer());
      const L = buf.length, x = new Float32Array(L);
      for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < L; i++) x[i] += d[i] / buf.numberOfChannels; }
      // onset：對數頻譜的正向變化量
      const frames = Math.max(0, Math.floor((L - N) / HOP)), env = new Float32Array(frames);
      // 音量起伏（每 0.5 秒一點）：用來挑最好聽的一段
      const half = Math.floor(SR / 2), e2 = [];
      for (let i = 0; i + half <= L; i += half) { let s = 0; for (let j = i; j < i + half; j += 4) s += x[j] * x[j]; e2.push(Math.sqrt(s / (half / 4))); }
      const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
      let prev = new Float32Array(N / 2);
      const re = new Float32Array(N), im = new Float32Array(N);
      for (let f = 0; f < frames; f++) {
        for (let i = 0; i < N; i++) { re[i] = x[f * HOP + i] * win[i]; im[i] = 0; }
        fft(re, im);
        let s = 0;
        const cur = new Float32Array(N / 2);
        for (let k = 1; k < N / 2; k++) { cur[k] = Math.log(1 + 100 * Math.hypot(re[k], im[k])); const d = cur[k] - prev[k]; if (d > 0) s += d; }
        env[f] = s; prev = cur;
      }
      // 去掉慢慢變化的部分、標準化
      const W = Math.round(FPS * 0.5), o = new Float32Array(frames);
      let sum = 0, sq = 0;
      for (let f = 0; f < frames; f++) {
        let m = 0, c = 0; for (let j = Math.max(0, f - W); j <= Math.min(frames - 1, f + W); j += 4) { m += env[j]; c++; }
        o[f] = Math.max(0, env[f] - m / c); sum += o[f]; sq += o[f] * o[f];
      }
      const sd = Math.sqrt(Math.max(1e-9, sq / frames - (sum / frames) ** 2));
      for (let f = 0; f < frames; f++) o[f] /= sd;
      // 速度：自相關 × 偏好 120 BPM 附近的權重
      let best = 0, bestLag = Math.round(FPS * 0.5);
      for (let lag = Math.round(FPS * 60 / 180); lag <= Math.round(FPS * 60 / 60); lag++) {
        let ac = 0; for (let f = lag; f < frames; f++) ac += o[f] * o[f - lag];
        const bpm = 60 * FPS / lag, w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
        if (ac * w > best) { best = ac * w; bestLag = lag; }
      }
      // 拍點：動態規劃（每一點 = onset + 前一拍的分數 − 間隔偏離理想拍長的懲罰）
      const P = bestLag, score = new Float32Array(frames), from = new Int32Array(frames).fill(-1);
      for (let f = 0; f < frames; f++) {
        let bs = 0, bp = -1;
        for (let q = f - 2 * P; q <= f - Math.round(P / 2); q++) {
          if (q < 0) continue;
          const v = score[q] - 100 * Math.log((f - q) / P) ** 2;
          if (bp < 0 || v > bs) { bs = v; bp = q; }
        }
        score[f] = o[f] + (bp >= 0 ? bs : 0); from[f] = bp;
      }
      let f = 0;
      for (let k = Math.max(0, frames - P); k < frames; k++) if (score[k] > score[f]) f = k;
      const beats = [];
      while (f >= 0) { beats.push((f * HOP + N / 2) / SR); f = from[f]; }
      beats.reverse();
      // 小節：4 拍一組，挑重拍（onset 加總最大）的起點
      let phase = 0, pb = -1;
      for (let ph = 0; ph < 4; ph++) {
        let s = 0; for (let i = ph; i < beats.length; i += 4) s += o[Math.round(beats[i] * SR / HOP - N / 2 / HOP)] || 0;
        if (s > pb) { pb = s; phase = ph; }
      }
      info = { beats, bars: beats.filter((_, i) => i % 4 === phase), bpm: 60 * FPS / P, dur: buf.duration, e2 };
      return info;
    } catch (e) { info = null; return null; }
  };
  HC.beatInfo = () => info;

  /* 挑音樂最好聽的一段：影片長度 total 秒
     - 開頭不要是很長的安靜前奏（前 4 秒的音量要夠）
     - 從小節的第一拍、而且是音樂「變化」的地方開始
     - 結尾盡量落在小節的開頭（樂句結束），而不是一句唱到一半 */
  HC.bestMusicOffset = (total) => {
    if (!info || !info.e2 || info.dur <= total + 2) return { off: 0, endOnBar: false };
    const e = info.e2, med = e.slice().sort((a, b) => a - b)[e.length >> 1] || 1e-6;
    const E = (t0, t1) => { let s = 0, n = 0; for (let k = Math.max(0, Math.floor(t0 * 2)); k < Math.min(e.length, Math.ceil(t1 * 2)); k++) { s += e[k]; n++; } return n ? s / n : 0; };
    let best = { off: 0, sc: -1e9, endOnBar: false };
    for (const b of [0, ...info.bars]) {
      if (b + total > info.dur - 0.5) break;
      const intro = Math.min(1.2, E(b, b + 4) / med);
      const rise = Math.max(0, E(b, b + 2) - E(b - 2, b)) / med;
      const end = b + total, nearBar = info.bars.some((x) => Math.abs(x - end) < 0.35);
      const drop = Math.max(0, E(end - 2, end) - E(end, end + 2)) / med;
      const sc = intro + 0.6 * Math.min(1, rise) + (nearBar ? 0.4 : 0) + 0.3 * Math.min(1, drop) - 0.004 * b;
      if (sc > best.sc) best = { off: +b.toFixed(2), sc, endOnBar: nearBar };
    }
    return best;
  };
  /* 拍點在成品時間軸上的位置（扣掉音樂起點） */
  HC.beatTimes = (bars) => {
    if (!info || !HC.state.music.url) return [];
    const off = HC.state.music.off || 0, { total } = HC.timeline();
    return (bars ? info.bars : info.beats).map((b) => b - off).filter((t) => t > 0.2 && t < total);
  };

  /* 把剪接點挪到最近的拍點上（優先小節的第一拍）
     - 只調整每個鏡頭的長度，最多 ±35%，鏡頭不會短於 1.2 秒
     - 靜止鏡頭：素材夠長就往後延；運鏡鏡頭：素材不夠時改調起點 */
  // 這段素材有沒有碰到不能用的地方（鼠標、介面、排除、太暗）
  const bad = (c, a, b) => {
    if (!c || !c.cls) return false;
    const { t, c: k } = c.cls;
    for (let i = 0; i < t.length; i++) if (t[i] >= a && t[i] <= b && "XCUE".includes(k[i])) return true;
    return false;
  };
  HC.snapToBeats = (shots) => {
    if (!info || !HC.state.music.url) return 0;
    const off = HC.state.music.off || 0;
    const beats = info.beats.map((b) => b - off), bars = new Set(info.bars.map((b) => +(b - off).toFixed(3)));
    const saved = HC.state.shots; HC.state.shots = shots;
    let moved = 0;
    try {
      for (let i = 0; i < shots.length - 1; i++) {
        const { starts } = HC.timeline(), s = shots[i], c = HC.clip(s.clipId);
        const od = HC.outDur(s), cut = starts[i + 1] + HC.trDur(i + 1) / 2;   // 轉場的中點當作剪接點
        let bestT = null, bestC = Infinity;
        for (const b of beats) {
          const d = b - cut, nd = od + d;
          if (nd < Math.max(1.2, od * 0.65) || nd > od * 1.35) continue;
          const cost = Math.abs(d) - (bars.has(+b.toFixed(3)) ? 0.25 : 0);
          if (cost < bestC) { bestC = cost; bestT = b; }
        }
        if (bestT == null || Math.abs(bestT - cut) < 0.02) continue;
        const nd = (od + bestT - cut) * s.speed, maxD = c && c.dur ? c.dur - 0.05 : 1e9;
        let ns = s.start;
        if (ns + nd > maxD || bad(c, ns, ns + nd)) ns = Math.min(maxD, s.start + s.dur) - nd;   // 往後延不行就改成往前多拿一點
        if (ns < 0 || bad(c, ns, ns + nd)) continue;
        s.start = +ns.toFixed(2); s.dur = +nd.toFixed(2); s._beat = true; moved++;
      }
    } finally { HC.state.shots = saved; }
    return moved;
  };
}
