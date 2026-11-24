/* 讀 MP4 的「目錄」（moov）：每一格畫面在檔案的哪裡、多大、什麼時間、是不是關鍵格
   逐格匯出用：有了目錄就能把畫面一格一格依序解碼（WebCodecs VideoDecoder），
   不用每一格都叫 <video> 跳轉（跳轉要從前一個關鍵格重新解碼，慢很多）。
   只支援一般 MP4／MOV 的 H.264；分段式 MP4、MKV、HEVC 等會回傳 null，改用跳轉的方式。
*/
{
  const HC = window.HC;
  const read = async (file, pos, len) => new DataView(await file.slice(pos, pos + len).arrayBuffer());
  const type = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  const u64 = (dv, o) => dv.getUint32(o) * 4294967296 + dv.getUint32(o + 4);
  const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);

  function boxes(dv, start, end) {
    const out = [];
    for (let p = start; p + 8 <= end;) {
      let size = dv.getUint32(p), hdr = 8;
      const t = type(dv, p + 4);
      if (size === 1) { size = u64(dv, p + 8); hdr = 16; } else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      out.push({ t, s: p + hdr, e: p + size });
      p += size;
    }
    return out;
  }
  const find = (dv, box, path) => {
    let cur = [box];
    for (const name of path) { const nx = []; for (const b of cur) for (const c of boxes(dv, b.s, b.e)) if (c.t === name) nx.push(c); cur = nx; }
    return cur;
  };

  HC.mp4Index = async (file) => {
    if (!file || !window.VideoDecoder) return null;
    // 1. 找 moov（可能在檔頭或檔尾；遇到分段式 MP4 就放棄）
    let pos = 0, moov = null;
    while (pos + 8 <= file.size) {
      const h = await read(file, pos, 16);
      let size = h.getUint32(0);
      const t = type(h, 4);
      if (size === 1) size = u64(h, 8); else if (size === 0) size = file.size - pos;
      if (size < 8) return null;
      if (t === "moof") return null;
      if (t === "moov") { moov = await read(file, pos, size); break; }
      pos += size;
    }
    if (!moov) return null;
    const root = { s: 8, e: moov.byteLength };
    const mvhd = find(moov, root, ["mvhd"])[0];
    const movieScale = mvhd ? moov.getUint32(mvhd.s + (moov.getUint8(mvhd.s) === 1 ? 20 : 12)) : 1000;
    // 2. 找影像軌
    const trak = find(moov, root, ["trak"]).find((tk) => { const h = find(moov, tk, ["mdia", "hdlr"])[0]; return h && type(moov, h.s + 8) === "vide"; });
    if (!trak) return null;
    const mdhd = find(moov, trak, ["mdia", "mdhd"])[0];
    const scale = moov.getUint32(mdhd.s + (moov.getUint8(mdhd.s) === 1 ? 20 : 12));
    const stbl = find(moov, trak, ["mdia", "minf", "stbl"])[0];
    const sub = (n) => boxes(moov, stbl.s, stbl.e).find((b) => b.t === n);
    // 3. 編碼格式（只做 H.264）
    const stsd = sub("stsd");
    const entry = boxes(moov, stsd.s + 8, stsd.e)[0];
    if (!entry || !/^avc[13]$/.test(entry.t)) return null;
    const width = moov.getUint16(entry.s + 24), height = moov.getUint16(entry.s + 26);
    const avcC = boxes(moov, entry.s + 78, entry.e).find((b) => b.t === "avcC");
    if (!avcC) return null;
    const description = new Uint8Array(moov.buffer, moov.byteOffset + avcC.s, avcC.e - avcC.s).slice();
    const hex = (i) => description[i].toString(16).padStart(2, "0");
    const codec = `avc1.${hex(1)}${hex(2)}${hex(3)}`;
    // 4. 每一格的時間
    const stts = sub("stts"), ctts = sub("ctts"), stss = sub("stss"), stsz = sub("stsz"), stsc = sub("stsc"), stco = sub("stco") || sub("co64");
    const n = moov.getUint32(stsz.s + 8), fixed = moov.getUint32(stsz.s + 4);
    const dts = new Float64Array(n), cts = new Float64Array(n), size = new Uint32Array(n), off = new Float64Array(n), sync = new Uint8Array(n);
    let k = 0, t = 0;
    for (let i = 0, c = moov.getUint32(stts.s + 4); i < c; i++) {
      const cnt = moov.getUint32(stts.s + 8 + i * 8), d = moov.getUint32(stts.s + 12 + i * 8);
      for (let j = 0; j < cnt && k < n; j++, k++) { dts[k] = t; t += d; }
    }
    cts.set(dts);
    if (ctts) {
      const v1 = moov.getUint8(ctts.s) === 1;
      k = 0;
      for (let i = 0, c = moov.getUint32(ctts.s + 4); i < c; i++) {
        const cnt = moov.getUint32(ctts.s + 8 + i * 8), o = v1 ? moov.getInt32(ctts.s + 12 + i * 8) : moov.getUint32(ctts.s + 12 + i * 8);
        for (let j = 0; j < cnt && k < n; j++, k++) cts[k] = dts[k] + o;
      }
    }
    if (stss) { for (let i = 0, c = moov.getUint32(stss.s + 4); i < c; i++) sync[moov.getUint32(stss.s + 8 + i * 4) - 1] = 1; }
    else sync.fill(1);
    for (let i = 0; i < n; i++) size[i] = fixed || moov.getUint32(stsz.s + 12 + i * 4);
    // 5. 每一格在檔案裡的位置
    const big = stco.t === "co64", nChunks = moov.getUint32(stco.s + 4);
    const chunkOff = (i) => (big ? u64(moov, stco.s + 8 + i * 8) : moov.getUint32(stco.s + 8 + i * 4));
    const sc = []; for (let i = 0, c = moov.getUint32(stsc.s + 4); i < c; i++) sc.push([moov.getUint32(stsc.s + 8 + i * 12) - 1, moov.getUint32(stsc.s + 12 + i * 12)]);
    k = 0;
    for (let e = 0; e < sc.length; e++) {
      const last = e + 1 < sc.length ? sc[e + 1][0] : nChunks;
      for (let ch = sc[e][0]; ch < last && k < n; ch++) { let p = chunkOff(ch); for (let j = 0; j < sc[e][1] && k < n; j++, k++) { off[k] = p; p += size[k]; } }
    }
    // 6. 剪輯清單（elst）：<video> 的時間會扣掉這段，這裡也要一樣，鏡頭的起點才對得上
    let shift = 0;
    const elst = find(moov, trak, ["edts", "elst"])[0];
    if (elst) {
      const v1 = moov.getUint8(elst.s) === 1, c = moov.getUint32(elst.s + 4), step = v1 ? 20 : 12;
      for (let i = 0; i < c; i++) {
        const p = elst.s + 8 + i * step;
        const segDur = v1 ? u64(moov, p) : moov.getUint32(p), mediaTime = v1 ? u64(moov, p + 8) : moov.getInt32(p + 4);
        if (mediaTime === -1 || mediaTime === 4294967295 * 4294967296 + 4294967295) { shift += segDur / movieScale; continue; }
        shift -= mediaTime / scale; break;
      }
    }
    const pts = new Float64Array(n);
    for (let i = 0; i < n; i++) pts[i] = cts[i] / scale + shift;
    const cfg = { codec, codedWidth: width, codedHeight: height, description };
    try { if (!(await VideoDecoder.isConfigSupported(cfg)).supported) return null; } catch (e) { return null; }
    return { cfg, n, pts, dts, size, off, sync, scale };
  };

  /* 一個鏡頭的畫面來源：依序解碼，frameAt(t) 回傳時間 ≤ t 的最後一格（和 <video> 跳到 t 時顯示的是同一格） */
  HC.decodeSource = (file, ix, from) => {
    const frames = [];   // 已解碼、還沒用掉的畫面（依時間排序）
    let k = 0, ended = false, err = null, wake = null, cur = null;
    // 從 from 之前最近的關鍵格開始
    for (let i = 0; i < ix.n; i++) { if (ix.pts[i] > from + 1e-4) break; if (ix.sync[i]) k = i; }
    const dec = new VideoDecoder({
      output: (f) => { frames.push(f); frames.sort((a, b) => a.timestamp - b.timestamp); wake && wake(); },
      error: (e) => { err = e; wake && wake(); },
    });
    dec.configure(ix.cfg);
    // 等解碼器吐出畫面；30 毫秒都沒有 → 回傳 false（有些解碼器要多餵幾格才會吐）
    const wait = () => new Promise((r) => {
      let done = false;
      const fin = (v) => { if (done) return; done = true; if (wake === me) wake = null; r(v); };
      const me = () => fin(true);
      wake = me; setTimeout(() => fin(false), 30);
    });
    async function feed() {
      // 一次送一小批：讀檔是非同步的，合併讀取比較快
      const a = k, b = Math.min(ix.n, k + 12);
      if (a >= b) { if (!ended) { ended = true; await dec.flush().catch(() => {}); } return; }
      let lo = Infinity, hi = 0;
      for (let i = a; i < b; i++) { lo = Math.min(lo, ix.off[i]); hi = Math.max(hi, ix.off[i] + ix.size[i]); }
      const all = hi - lo < 32 * 1048576 ? new Uint8Array(await file.slice(lo, hi).arrayBuffer()) : null;
      for (let i = a; i < b; i++) {
        const data = all ? all.subarray(ix.off[i] - lo, ix.off[i] - lo + ix.size[i]) : new Uint8Array(await file.slice(ix.off[i], ix.off[i] + ix.size[i]).arrayBuffer());
        dec.decode(new EncodedVideoChunk({ type: ix.sync[i] ? "key" : "delta", timestamp: Math.round(ix.pts[i] * 1e6), duration: 0, data }));
      }
      k = b;
    }
    return {
      async frameAt(t) {
        const us = Math.round(t * 1e6) + 500;
        // 解到「下一格已經超過 t」為止，才確定 ≤ t 的最後一格是哪一格
        // 解碼器能同時借出的畫面有限（大約 10 格），沒用到的舊畫面要馬上還回去，不然會卡住
        const prune = () => {
          let pick = -1;
          for (let i = 0; i < frames.length; i++) if (frames[i].timestamp <= us) pick = i;
          if (pick < 0) return;
          if (cur) cur.close();
          cur = frames[pick];
          frames.splice(0, pick + 1).slice(0, -1).forEach((f) => f.close());
        };
        for (;;) {
          prune();
          if (err || frames.length || (ended && dec.decodeQueueSize === 0)) break;   // 有一格超過 t 了 → ≤ t 的最後一格就是 cur
          if (ended) { await wait(); continue; }
          if (dec.decodeQueueSize < 8 || !(await wait())) await feed();
        }
        if (err) throw err;
        if (!cur && frames.length) cur = frames.shift();
        return cur;
      },
      /* 依序拿下一格（分析、防抖量測用）；沒有了回傳 null */
      async nextFrame() {
        while (!err && !frames.length && !(ended && dec.decodeQueueSize === 0)) {
          if (ended) { await wait(); continue; }
          if (dec.decodeQueueSize < 8 || !(await wait())) await feed();
        }
        if (err) throw err;
        if (cur) { cur.close(); cur = null; }
        if (!frames.length) return null;
        cur = frames.shift();
        return cur;
      },
      close() { try { dec.close(); } catch (e) {} if (cur) cur.close(); cur = null; frames.forEach((f) => f.close()); frames.length = 0; },
    };
  };
}
