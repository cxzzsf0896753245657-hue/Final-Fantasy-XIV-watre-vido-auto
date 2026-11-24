/* 白天／夜晚判斷、自動配色、相似畫面
   - 白天／夜晚：看每個場景的平均亮度。比最亮的場景暗很多（或本身就很暗）就算夜晚；可以在素材區手動改
   - 自動配色：每個鏡頭取 3 格量亮度、冷暖、飽和度，白天、夜晚各自對齊到中位數（只調七成，保留原本的氣氛）
   - 相似畫面：比較兩段素材的細節分布（4×4 格）和色彩，用來去掉重複的角度、找日夜對比的鏡頭
*/
{
  const HC = window.HC;
  const mean = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };

  /* ---------- 白天／夜晚 ---------- */
  HC.TOD_NAMES = { "": "自動", day: "白天", night: "夜晚" };
  const sceneLuma = (scene) => mean(HC.state.clips.filter((c) => c.scene === scene && c.ana).map((c) => mean(c.ana.luma)));
  HC.timeOfDay = (scene) => {
    const cs = HC.state.clips.filter((c) => c.scene === scene);
    const set = cs.find((c) => c.tod);
    if (set) return { tod: set.tod, guess: false };
    const ys = [...new Set(HC.state.clips.map((c) => c.scene))].map(sceneLuma).filter((y) => y > 0);
    const y = sceneLuma(scene), ref = Math.max(...ys, 1);
    return { tod: y && (y < 47 || y < ref * 0.7) ? "night" : "day", guess: true };
  };
  HC.setTimeOfDay = (scene, tod) => { for (const c of HC.state.clips) if (c.scene === scene) c.tod = tod; };
  HC.shotTod = (s) => { const c = HC.clip(s.clipId); return c ? HC.timeOfDay(c.scene || 0).tod : "day"; };

  /* ---------- 相似畫面 ---------- */
  /* noColor：日夜對比用，白天和夜晚顏色本來就不一樣，只比構圖 */
  HC.shotSimilarity = (a, b, noColor) => {
    const la = HC.shotLook(a.clipId, a.start, a.start + a.dur), lb = HC.shotLook(b.clipId, b.start, b.start + b.dur);
    const ca = HC.clip(a.clipId), cb = HC.clip(b.clipId);
    if (!la || !lb) return 0;
    // 細節分布越像、目標點越近 → 角度越像
    const ga = gridOf(a), gb = gridOf(b);
    let dot = 0, na = 0, nb = 0;
    for (let k = 0; k < 16; k++) { dot += ga[k] * gb[k]; na += ga[k] ** 2; nb += gb[k] ** 2; }
    const cos = dot / Math.sqrt(na * nb || 1);
    const fd = Math.hypot(la.focus[0] - lb.focus[0], la.focus[1] - lb.focus[1]);
    const col = ca && cb && ca.ana && cb.ana ? 1 - HC.sigDiff(ca.ana.sig, cb.ana.sig) : 0.5;
    if (noColor) return HC.clamp((cos - 0.6) / 0.4, 0, 1) * 0.75 + HC.clamp(1 - fd * 3, 0, 1) * 0.25;
    return HC.clamp((cos - 0.85) / 0.15, 0, 1) * 0.6 + HC.clamp(1 - fd * 3, 0, 1) * 0.2 + col * 0.2;
  };
  function gridOf(s) {
    const A = HC.clip(s.clipId) && HC.clip(s.clipId).ana, g = new Array(16).fill(0);
    if (!A || !A.grid) return g;
    let n = 0;
    A.gt.forEach((t, i) => { if (t >= s.start - 0.25 && t <= s.start + s.dur + 0.25) { for (let k = 0; k < 16; k++) g[k] += A.grid[i][k]; n++; } });
    // 去掉整體亮度、只看分布
    const m = mean(g) || 1;
    return g.map((v) => v / m - 1);
  }
  /* 日夜對比：找一組白天、夜晚的鏡頭，角度最像的 */
  HC.findDayNightPair = (shots) => {
    const day = shots.filter((s) => s.mode !== "move" && HC.shotTod(s) === "day"), night = shots.filter((s) => s.mode !== "move" && HC.shotTod(s) === "night");
    let best = null, bs = 0.3;
    for (const a of day) for (const b of night) {
      const v = HC.shotSimilarity(a, b, true) - (HC.clip(a.clipId).stype && HC.clip(a.clipId).stype !== HC.clip(b.clipId).stype ? 0.3 : 0);
      if (v > bs) { bs = v; best = [a, b]; }
    }
    return best;
  };

  /* ---------- 自動配色 ---------- */
  async function sample(s, v, cx) {
    const c = HC.clip(s.clipId);
    if (!c || !c.url) return null;
    if (v.dataset.clip !== c.id) { v.src = c.url; v.dataset.clip = c.id; await HC.once(v, "loadeddata", 15000); }
    let R = 0, G = 0, B = 0, Sat = 0, n = 0;
    for (const u of [0.2, 0.5, 0.8]) {
      v.currentTime = HC.clamp(HC.srcTime(s, HC.moveDur(s) * u), 0, v.duration - 0.05);
      await HC.once(v, "seeked", 8000);
      cx.drawImage(v, 0, 0, 64, 36);
      const d = cx.getImageData(0, 0, 64, 36).data;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        R += r; G += g; B += b; Sat += mx ? (mx - mn) / mx : 0; n++;
      }
    }
    R /= n; G /= n; B /= n;
    return { y: 0.3 * R + 0.59 * G + 0.11 * B, warm: (R - B) / (R + G + B + 1), sat: Sat / n };
  }
  HC.autoColor = async (shots, strength = 0.7) => {
    const v = document.createElement("video"); v.muted = true; v.preload = "auto";
    const cv = document.createElement("canvas"); cv.width = 64; cv.height = 36;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    const st = new Map();
    try { for (const s of shots) { const x = await sample(s, v, cx).catch(() => null); if (x) st.set(s, x); } }
    finally { v.removeAttribute("src"); v.load(); }
    let n = 0;
    for (const tod of ["day", "night"]) {
      const group = shots.filter((s) => st.has(s) && HC.shotTod(s) === tod);
      if (group.length < 2) continue;
      const ty = median(group.map((s) => st.get(s).y)), tw = median(group.map((s) => st.get(s).warm)), ts = median(group.map((s) => st.get(s).sat));
      for (const s of group) {
        const x = st.get(s), a = { ...(s.adj || {}) };
        a.b = +HC.clamp(((ty / Math.max(5, x.y)) - 1) / 0.45 * strength, -0.6, 0.6).toFixed(2);
        a.t = +HC.clamp((tw - x.warm) * 6 * strength, -0.6, 0.6).toFixed(2);
        a.s = +HC.clamp(((ts / Math.max(0.02, x.sat)) - 1) / 0.7 * strength, -0.5, 0.5).toFixed(2);
        for (const k of ["b", "t", "s"]) if (Math.abs(a[k]) < 0.03) delete a[k];
        if (Object.keys(a).length) s.adj = a; else delete s.adj;
        n++;
      }
    }
    return n;
  };
}
