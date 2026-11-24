/* 美感：從兩個來源學來的規則，用在開頭片尾、畫面文字、特效和轉場
   來源（「學習」分頁的「美感來源」可以個別開關）：
   1. Taste Skill（github.com/Leonxlnx/taste-skill，MIT 授權，© 2026 Leonxlnx）
      - 調色盤：從它的 64 組裡挑出適合「地方」類（旅館、咖啡廳、婚禮、工作室、餐廳）的 10 組，
        淺色底當字色、重點色調亮到在影片上看得清楚。每組只有一個重點色，不用紫色。
      - 文字和背景要有足夠對比；字太亮的畫面用實心底框，不用漸層遮罩。
      - 動態：不回彈、不過衝，進場最多 1.1 秒；不要閃爍、亂閃的裝飾。
   2. Skillry 的 Opus 5.5 影片集（skillry.dev/ai-videos/opus-5-5）裡的設計提示
      - 大字用粗體，小字細一點並拉開字距（0.14–0.3 em）
      - 靜止的文字離左右邊至少 8%、上下至少 8%
      - 不用光暈、粒子爆炸、鏡頭晃動、RGB 分離、炫光；不要停太久的畫面
   「依畫面自動挑」會量畫面的亮度、冷暖、綠色、飽和度和白天／夜晚，再加上你以前選過的組合。
   你按「修正」的項目會被記住，修過兩次以上的問題，之後自動剪輯會直接修好。 */
{
  const HC = window.HC;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  HC.TASTE_SOURCES = [
    { id: "taste", name: "Taste Skill", by: "Leonxlnx・MIT 授權", url: "https://github.com/Leonxlnx/taste-skill",
      learned: ["10 組配色（從 64 組裡挑適合旅館、咖啡廳、婚禮、工作室的），每組一個重點色、不用紫色", "文字和背景要有足夠對比，太亮的畫面加實心底框", "動態不回彈、不過衝，進場最多 1.1 秒", "不要閃爍、亂閃的裝飾"] },
    { id: "skillry", name: "Skillry：Opus 5.5 影片集", by: "418 支用 Claude Opus 5.5 做的影片", url: "https://skillry.dev/ai-videos/opus-5-5",
      learned: ["大字粗、小字細並拉開字距（0.14–0.3 em）", "靜止的文字離畫面邊緣至少 8%", "不用光暈、粒子、炫光、閃白這類效果", "不要停太久的靜止畫面"] },
  ];
  const srcOn = (id) => { const m = (HC.profile && HC.profile.tasteSrc) || {}; return m[id] !== false; };
  HC.tasteSrcOn = srcOn;

  /* ---------- 顏色工具 ---------- */
  const hex2 = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const toHex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const relLum = (h) => { const [r, g, b] = hex2(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const mix = (h, w, k) => toHex(hex2(h).map((v, i) => v + (hex2(w)[i] - v) * k));
  // 重點色調亮到在深色畫面上也看得到（對 #161616 至少 4.5:1）
  const videoAccent = (h) => { let c = h, k = 0; while (ratio(relLum(c), relLum("#161616")) < 4.5 && k < 1) { k += 0.08; c = mix(h, "#ffffff", k); } return c; };
  const hueOf = (h) => { const [r, g, b] = hex2(h).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return { h: 0, s: 0 }; let hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh *= 60; if (hh < 0) hh += 360; return { h: hh, s: d / (1 - Math.abs(mx + mn - 1) || 1) }; };
  const isViolet = (h) => { if (!/^#[0-9a-f]{6}$/i.test(h || "")) return false; const x = hueOf(h); return x.s > 0.2 && x.h >= 265 && x.h <= 330; };
  // 紫色 → 轉到最近的藍（255°）或玫瑰色（345°）
  const unViolet = (h) => {
    const [r, g, b] = hex2(h).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), L = (mx + mn) / 2, d = mx - mn, S = d / (1 - Math.abs(2 * L - 1) || 1);
    const H = hueOf(h).h < 300 ? 255 : 345, C = (1 - Math.abs(2 * L - 1)) * S, X = C * (1 - Math.abs(((H / 60) % 2) - 1)), m = L - C / 2;
    const [rr, gg, bb] = H < 300 ? [0, X, C] : [C, 0, X];
    return toHex([rr + m, gg + m, bb + m].map((v) => v * 255));
  };

  /* ---------- 美感組合（配色出自 Taste Skill 的 library/palettes.json） ---------- */
  // ink = 字色（調色盤的淺色底）；accent = 重點色（調亮給影片用）；mood = 適合的畫面
  const K = (id, name, pal, ink, sub, accent, o) => ({ id, name, pal, ink, sub, accent: videoAccent(accent), raw: accent, ...o });
  HC.KITS = [
    K("garden", "庭園綠意", "moss-sand", "#f2eee4", "#ddd6c6", "#4f6238", { tpl: "classic", font: "Noto Serif TC", weight: 600, mood: { green: 1.2, bright: 0.3, warm: 0.2 }, text: "caption" }),
    K("wa", "和風靜謐", "olive-on-bone", "#ecebe7", "#d9d8d0", "#38450f", { tpl: "underline", font: "Noto Serif TC", weight: 600, mood: { green: 0.7, sat: -0.6, warm: 0.1 }, text: "lower" }),
    K("cabin", "溫馨木屋", "warm-paper-walnut", "#f7f3ec", "#e8dfd1", "#7a4a2c", { tpl: "infocard", font: "LXGW WenKai TC", weight: 400, mood: { warm: 1.2, bright: -0.2 }, text: "lower" }),
    K("forest", "森林小屋", "clay-pine", "#efe9e0", "#ddd5c9", "#2e5b44", { tpl: "infocard", font: "Noto Serif TC", weight: 600, mood: { green: 1, bright: -0.5 }, text: "lower" }),
    K("harbour", "水岸海景", "linen-harbour", "#f3f1ec", "#dfe3e6", "#2c5877", { tpl: "classic", font: "Noto Sans TC", weight: 700, mood: { cool: 1.2, bright: 0.5 }, text: "lower" }),
    K("stone", "石材簡約", "three-stones", "#eeecea", "#d6d4d1", "#5c6b54", { tpl: "underline", font: "Noto Sans TC", weight: 700, mood: { sat: -1.2, bright: 0.2 }, text: "lower" }),
    K("sun", "南歐暖陽", "limewash-ochre", "#f4efe5", "#e6dcc8", "#8c6418", { tpl: "classic", font: "Noto Serif TC", weight: 600, mood: { warm: 1, bright: 0.8, sat: 0.4 }, text: "caption" }),
    K("rose", "浪漫花園", "plaster-rose", "#f6f0eb", "#ead9d3", "#9a3c4c", { tpl: "underline", font: "LXGW WenKai TC", weight: 400, mood: { sat: 0.9, warm: 0.4, bright: 0.3 }, text: "caption" }),
    K("night", "夜色金燈", "bottle-green-gold", "#f6edd0", "#e9dcae", "#f4d96c", { tpl: "cinema", font: "Noto Serif TC", weight: 600, mood: { night: 1.6, warm: 0.3 }, text: "caption" }),
    K("modern", "冷調現代", "cool-white-slate", "#f7f9fa", "#dfe6ea", "#0d7480", { tpl: "infocard", font: "Noto Sans TC", weight: 700, mood: { cool: 0.8, sat: -0.6, bright: 0.2 }, text: "lower" }),
  ];
  HC.kit = (id) => HC.KITS.find((k) => k.id === id);

  /* 套用一組：只改樣式，不改你打的字 */
  HC.applyKit = (id, byUser) => {
    const k = HC.kit(id); if (!k) return;
    const S = HC.state, T = S.title, sk = srcOn("skillry");
    S.look.kit = id;
    if (srcOn("taste")) {
      if (T.template !== "none") T.template = k.tpl;
      T.font = k.font; T.color = k.ink; T.subColor = k.sub; T.accent = k.accent; T.calm = true;
      T.line = k.tpl === "classic" || k.tpl === "underline";
    }
    T.weight = sk ? Math.min(900, (k.weight || 600) + (k.font === "Noto Sans TC" ? 200 : k.font === "Noto Serif TC" ? 300 : 0)) : k.weight;
    T.subWeight = sk ? 400 : 400; T.track = sk ? 0.18 : 0; T.trackMain = sk ? 0.02 : 0;
    S.look.text = { color: k.ink, accent: k.accent, weight: sk ? (k.text === "lower" ? 500 : 700) : undefined, track: sk ? 0.14 : 0 };
    for (const t of S.texts || []) if (!t.styleSet) t.style = k.text === "lower" && t.style === "caption" ? "lower" : t.style;
    if (byUser) learnKit(id);
  };
  function learnKit(id) {
    const P = HC.profile; if (!P) return;
    P.look.kit = P.look.kit || {};
    for (const x of Object.keys(P.look.kit)) P.look.kit[x] *= 0.85;
    P.look.kit[id] = (P.look.kit[id] || 0) + 1;
    HC.saveProfile && HC.saveProfile();
  }

  /* ---------- 量畫面 ---------- */
  const vid = () => { const v = document.createElement("video"); v.muted = true; v.preload = "auto"; return v; };
  const cv = document.createElement("canvas"); cv.width = 64; cv.height = 36;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  // 量某個鏡頭在 lt 秒時，畫面某一塊（rect = [x0, y0, x1, y1]，0–1）的平均亮度、冷暖、綠色、飽和度、亮度起伏
  async function measure(v, s, lt, rect = [0, 0, 1, 1]) {
    const c = HC.clip(s.clipId); if (!c || !c.url) return null;
    if (v.dataset.clip !== c.id) { v.src = c.url; v.dataset.clip = c.id; await HC.once(v, "loadeddata", 15000); }
    v.currentTime = HC.clamp(HC.srcTime(s, Math.max(0, lt)), 0, (v.duration || c.dur) - 0.05);
    await HC.once(v, "seeked", 8000);
    cx.drawImage(v, 0, 0, 64, 36);
    const x0 = Math.floor(rect[0] * 64), y0 = Math.floor(rect[1] * 36), x1 = Math.max(x0 + 1, Math.ceil(rect[2] * 64)), y1 = Math.max(y0 + 1, Math.ceil(rect[3] * 36));
    const d = cx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let R = 0, G = 0, B = 0, Sat = 0, L = 0, L2 = 0, Y = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b), y = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
      R += r; G += g; B += b; Sat += mx ? (mx - mn) / mx : 0; L += l; Y += y; L2 += y * y; n++;
    }
    R /= n; G /= n; B /= n; Y /= n;
    return { lum: L / n, y: Y, sd: Math.sqrt(Math.max(0, L2 / n - Y * Y)), warm: (R - B) / (R + G + B + 1), green: (G - (R + B) / 2) / (R + G + B + 1), sat: Sat / n };
  }

  /* ---------- 依畫面挑一組 ---------- */
  HC.dealKit = async () => {
    const S = HC.state, sh = S.shots; if (!sh.length) return null;
    const v = vid(), picks = sh.filter((_, i) => i % Math.max(1, Math.floor(sh.length / 8)) === 0).slice(0, 8), ms = [];
    try { for (const s of picks) { const m = await measure(v, s, HC.moveDur(s) * 0.5).catch(() => null); if (m) ms.push(m); } }
    finally { v.removeAttribute("src"); v.load(); }
    if (!ms.length) return null;
    const avg = (k) => ms.reduce((a, m) => a + m[k], 0) / ms.length;
    const night = sh.filter((s) => HC.shotTod && HC.shotTod(s) === "night").length / sh.length;
    const f = { warm: avg("warm") * 7, cool: -avg("warm") * 7, green: avg("green") * 9, sat: (avg("sat") - 0.3) * 4, bright: (avg("y") - 0.42) * 4, night: night * 2 - (avg("y") < 0.22 ? -0.6 : 0) };
    const pref = (HC.profile && HC.profile.look.kit) || {}, pmax = Math.max(1, ...Object.values(pref));
    const scored = HC.KITS.map((k) => ({ k, s: Object.entries(k.mood).reduce((a, [m, w]) => a + w * (f[m] || 0), 0) + 0.8 * ((pref[k.id] || 0) / pmax) })).sort((a, b) => b.s - a.s);
    const why = [];
    if (f.night > 0.8) why.push("夜晚畫面多"); else why.push("白天");
    if (f.green > 0.25) why.push("綠色多"); if (f.warm > 0.35) why.push("偏暖"); else if (f.cool > 0.2) why.push("偏冷");
    if (f.sat < -0.4) why.push("顏色素雅"); else if (f.sat > 0.4) why.push("顏色鮮豔");
    if (f.bright > 0.5) why.push("明亮");
    if ((pref[scored[0].k.id] || 0) > 0.5) why.push("你常選這組");
    return { kit: scored[0].k, alt: scored.slice(1, 3).map((x) => x.k), why };
  };

  /* ---------- 美感檢查 ---------- */
  const LV = { bad: 12, warn: 6, info: 2 };
  const textRect = (style, pos) => pos === "top" ? [0.2, 0.08, 0.8, 0.25] : pos === "bottom" || (style === "lower" && !pos) ? [0.25, 0.76, 0.75, 0.92] : [0.18, 0.38, 0.82, 0.56];
  const titleRect = (T) => {
    const tpl = HC.titleTpl(T.template), p = T.pos === "center" && tpl.layout === "center" ? "auto" : T.pos || "auto";
    if (p === "top") return [0.2, 0.1, 0.8, 0.3];
    if (p === "bottom") return [0.2, 0.6, 0.8, 0.82];
    if (p === "lowleft" || (p === "auto" && tpl.layout === "lowleft")) return [0.06, 0.58, 0.5, 0.84];
    if (p === "auto" && tpl.layout === "left") return [0.08, 0.32, 0.55, 0.58];
    if (p === "auto" && tpl.layout === "cinema") return [0.2, 0.62, 0.8, 0.82];
    return [0.2, 0.3, 0.8, 0.56];
  };
  async function contrastAt(v, T, rect, ink) {
    const at = HC.shotAt(T); if (!at || at.i < 0) return null;
    const s = HC.state.shots[at.i], m = await measure(v, s, at.off, rect).catch(() => null);
    if (!m) return null;
    return { r: ratio(relLum(ink || "#ffffff"), m.lum), busy: m.sd, m };
  }
  HC.tasteContrast = async (T, rect, ink) => { const v = vid(); try { return await contrastAt(v, T, rect, ink); } finally { v.removeAttribute("src"); v.load(); } };
  HC.tasteCheck = async () => {
    const S = HC.state, T = S.title, out = [], { starts, total } = HC.timeline();
    if (!S.shots.length) return { score: 0, items: [] };
    const add = (id, lv, msg, src, fix, fixName) => out.push({ id, lv, msg, src, fix, fixName });
    const v = vid();
    try {
      /* 1. 文字對比（Taste Skill：每個字都要看得清楚） */
      if (srcOn("taste")) {
        if (T.template !== "none" && T.main) {
          const c = await contrastAt(v, Math.min(total - 0.1, (T.at || 0) + Math.min(T.dur * 0.6, 2.6)), titleRect(T), T.color);
          if (c && !T.box && (c.r < 2.6 || c.busy > 0.2)) add("titleContrast", c.r < 1.8 ? "bad" : "warn", `開頭標題的背景${c.r < 2.6 ? "太亮" : "太花"}（對比 ${c.r.toFixed(1)}:1），字不容易看清楚`, "taste", async () => {
            let best = { r: c.r, pos: T.pos }; const opts = ["top", "middle", "bottom", "lowleft"];
            for (const p of opts) { const c2 = await contrastAt(v2(), Math.min(total - 0.1, (T.at || 0) + Math.min(T.dur * 0.6, 2.6)), titleRect({ ...T, pos: p }), T.color); if (c2 && c2.r - c2.busy * 4 > best.r) best = { r: c2.r - c2.busy * 4, pos: p }; }
            if (best.pos !== T.pos && best.r >= 2.6) T.pos = best.pos; else T.box = true;
          }, "換到比較暗的位置，或加底框");
        }
        for (const t of S.texts || []) {
          if (!t.text || t.style === "lower" || t.box) continue;
          const [a, b] = HC.textSpan(t, starts, total), c = await contrastAt(v, (a + b) / 2, textRect(t.style, t.pos), t.color || (S.look.text || {}).color);
          if (c && (c.r < 2.6 || c.busy > 0.22)) add("textContrast:" + t.id, c.r < 1.8 ? "bad" : "warn", `文字「${t.text}」的背景${c.r < 2.6 ? "太亮" : "太花"}（對比 ${c.r.toFixed(1)}:1）`, "taste", async () => {
            let best = { r: c.r - c.busy * 4, pos: t.pos };
            for (const p of ["top", "center", "bottom"]) { const c2 = await contrastAt(v2(), (a + b) / 2, textRect(t.style, p), t.color); if (c2 && c2.r - c2.busy * 4 > best.r + 0.4) best = { r: c2.r - c2.busy * 4, pos: p }; }
            if (best.pos !== t.pos && best.r >= 2.6) t.pos = best.pos; else t.box = true;
          }, "換位置或加底框");
        }
      }
    } finally { v.removeAttribute("src"); v.load(); cleanupV2(); }
    /* 2. 紫色（Taste Skill：不用紫色） */
    if (srcOn("taste")) {
      const cols = [["title.color", T.color], ["title.accent", T.accent], ["title.subColor", T.subColor], ["text.color", (S.look.text || {}).color], ["text.accent", (S.look.text || {}).accent]].filter(([, c]) => isViolet(c));
      if (cols.length) add("violet", "warn", "用了紫色系的字色或重點色", "taste", () => { for (const [k] of cols) { const [o, f] = k.split("."); const obj = o === "title" ? T : S.look.text; obj[f] = unViolet(obj[f]); } }, "換成藍或玫瑰色");
      /* 3. 只用一個重點色 */
      const acc = new Set([T.accent, (S.look.text || {}).accent].filter(Boolean).map((x) => x.toLowerCase()));
      if (acc.size > 1) add("accent", "info", "開頭和畫面文字用了不同的重點色", "taste", () => { S.look.text.accent = T.accent; }, "統一成開頭的重點色");
      /* 4. 動態：回彈、過衝 */
      const tpl = HC.titleTpl(T.template);
      if (!T.calm && T.template !== "none") add("calm", T.template === "rise" ? "warn" : "info", T.template === "rise" ? "開頭標題的動畫會回彈（過衝）" : "開頭動畫可以更收斂（不回彈、進場 1.1 秒內）", "taste", () => { T.calm = true; }, "改成克制的動態");
      void tpl;
    }
    /* 5. 花俏效果（Skillry 的禁用清單：光暈、粒子、炫光；Taste Skill：不要亂閃的裝飾） */
    if (srcOn("skillry") || srcOn("taste")) {
      const deco = (S.fxItems || []).filter((x) => ["glow", "bokeh", "petals"].includes(x.fx));
      let overlap = false;
      for (let i = 0; i < deco.length; i++) for (let j = i + 1; j < deco.length; j++) { const [a1, b1] = HC.spanOf(deco[i], total), [a2, b2] = HC.spanOf(deco[j], total); if (deco[i].fx !== deco[j].fx && a1 < b2 && a2 < b1) overlap = true; }
      if (overlap) add("fxStack", "warn", "同時疊了好幾種光暈／光點／落花效果", "skillry", () => { const keep = deco.slice().sort((p, q) => (q.str ?? 0.6) - (p.str ?? 0.6))[0]; S.fxItems = S.fxItems.filter((x) => !deco.includes(x) || x === keep); }, "只留最強的一種");
      const strong = deco.filter((x) => (x.str ?? 0.6) > 0.55 && x.fx !== "petals");
      if (strong.length) add("fxStrong", "info", `「${strong.map((x) => (HC.EFFECTS.find((e) => e.id === x.fx) || {}).name).join("、")}」強度偏高，會蓋過房子本身`, "skillry", () => { for (const x of strong) x.str = 0.45; }, "降到 45%");
      const flashy = S.shots.filter((s) => s.tr && ["flash", "circle", "zoom", "white"].includes(s.tr.type));
      if (flashy.length) add("trFlashy", flashy.length > 2 ? "warn" : "info", `${flashy.length} 個轉場比較花俏（閃白、圓形、縮放穿越）`, "skillry", () => { for (const s of flashy) s.tr = { type: "fade", dur: 0.8 }; }, "改成疊化");
    }
    /* 6. 轉場種類太多 */
    // 黑場是換場景用的，不算；花俏的轉場不會被選來統一
    const FLASHY = ["flash", "circle", "zoom", "white"], kinds = {}; for (const s of S.shots) if (s.tr && s.tr.type !== "cut" && s.tr.type !== "black") kinds[s.tr.type] = (kinds[s.tr.type] || 0) + 1;
    if (Object.keys(kinds).length > 2) { const top = (Object.entries(kinds).filter(([k]) => !FLASHY.includes(k)).sort((a, b) => b[1] - a[1])[0] || ["fade"])[0]; add("trMix", "warn", `用了 ${Object.keys(kinds).length} 種轉場，風格不統一`, "taste", () => { for (const s of S.shots) if (s.tr && s.tr.type !== "cut" && s.tr.type !== top && s.tr.type !== "black") s.tr = { type: top, dur: (HC.TRANSITIONS.find((x) => x.id === top) || {}).dur || 0.8 }; }, `統一成「${(HC.TRANSITIONS.find((x) => x.id === top) || {}).name || top}」`); }
    /* 7. 停太久的靜止畫面 */
    if (srcOn("skillry")) {
      const long = S.shots.filter((s) => s.mode === "none" && !(s.zoom > 0.02) && !s.split && !s.pip && HC.outDur(s) > 6.5);
      if (long.length) add("hold", "warn", `${long.length} 個完全不動的鏡頭超過 6.5 秒`, "skillry", () => { for (const s of long) { s.mode = "in"; s.zoom = Math.max(0.06, s.zoom || 0); } }, "加一點慢慢推近");
    }
    /* 8. 文字：太短、太長、重疊、超出安全範圍 */
    const texts = (S.texts || []).filter((t) => t.text);
    const spans = texts.map((t) => [t, ...HC.textSpan(t, starts, total)]);
    const short = spans.filter(([, a, b]) => b - a < 1.6);
    if (short.length) add("textShort", "warn", `${short.length} 段文字出現不到 1.6 秒，來不及看`, "taste", () => { for (const [t, a] of short) { if (t.shotId) delete t.shotId; t.start = a; t.dur = 2.2; } }, "延長到 2.2 秒");
    const long = texts.filter((t) => [...t.text].length > 18);
    if (long.length) add("textLong", "info", `文字「${long[0].text.slice(0, 10)}…」太長，一行最好 18 個字以內，其他可以放到小字`, "taste");
    for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
      const [t1, a1, b1] = spans[i], [t2, a2, b2] = spans[j];
      if (a1 < b2 && a2 < b1 && (t1.pos || "center") === (t2.pos || "center")) { add("textOverlap:" + t2.id, "bad", `「${t1.text}」和「${t2.text}」同時出現在同一個位置`, "taste", () => { t2.pos = (t1.pos || "center") === "bottom" ? "top" : "bottom"; }, "把後面那段移開"); }
    }
    if (srcOn("skillry")) {
      const ctx = cx, u = 1;
      const wide = texts.filter((t) => { const fs = (t.style === "big" ? 130 : t.style === "lower" ? 46 : 88) * u; ctx.font = `700 ${fs}px "Noto Sans TC"`; return ctx.measureText(t.text).width > 1920 * 0.84; });
      if (wide.length) add("safe", "warn", `${wide.length} 段文字太寬，碰到畫面邊緣的安全範圍`, "skillry", () => { for (const t of wide) t.style = t.style === "big" ? "caption" : "lower"; }, "改小一級");
      if (T.template !== "none" && T.main) {
        ctx.font = `${T.weight || 600} ${T.size}px "${T.font}"`; const w = ctx.measureText(T.main).width + (T.trackMain || 0) * T.size * [...T.main].length;
        if (w > 1920 * 0.84) add("titleWide", "warn", "開頭標題太寬，超出安全範圍", "skillry", () => { T.size = Math.max(40, Math.floor(T.size * 1920 * 0.72 / w)); }, "縮小到畫面寬的 72%");
      }
      if (!T.track && T.template !== "none" && (T.sub || T.info)) add("track", "info", "副標可以細一點、拉開字距，和大標拉出層次", "skillry", () => { T.track = 0.18; T.subWeight = 400; T.weight = Math.max(T.weight || 600, 700); }, "拉開字距");
    }
    /* 9. 文字樣式一致 */
    const styles = new Set(texts.map((t) => (t.style || "caption") + (t.pos || "")));
    if (styles.size > 2) { const cnt = {}; for (const t of texts) cnt[t.style || "caption"] = (cnt[t.style || "caption"] || 0) + 1; const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0]; add("textMix", "info", `畫面文字用了 ${styles.size} 種樣式／位置`, "taste", () => { for (const t of texts) if (!t.box) t.style = top; }, "統一樣式"); }

    const score = Math.max(0, 100 - out.reduce((a, x) => a + LV[x.lv], 0));
    out.sort((a, b) => LV[b.lv] - LV[a.lv]);
    return { score, items: out };
  };
  // 修正時另外開一個 video（檢查用的那個已經釋放）
  let v2el = null;
  const v2 = () => (v2el = v2el || vid());
  const cleanupV2 = () => {};
  HC.tasteFix = async (item) => {
    if (!item.fix) return;
    await item.fix();
    if (v2el) { v2el.removeAttribute("src"); v2el.load(); v2el = null; }
    const P = HC.profile; if (P) { P.look.tasteFix = P.look.tasteFix || {}; const k = item.id.split(":")[0]; P.look.tasteFix[k] = (P.look.tasteFix[k] || 0) + 1; HC.saveProfile && HC.saveProfile(); }
  };
  // 自動剪輯後：修過兩次以上的問題直接修好
  HC.tasteAuto = async () => {
    const P = HC.profile, learned = (P && P.look.tasteFix) || {};
    if (!Object.values(learned).some((n) => n >= 2)) return [];
    const r = await HC.tasteCheck(), done = [];
    for (const it of r.items) if (it.fix && (learned[it.id.split(":")[0]] || 0) >= 2) { await it.fix(); done.push(it.msg); }
    if (v2el) { v2el.removeAttribute("src"); v2el.load(); v2el = null; }
    return done;
  };

  /* ---------- 介面 ---------- */
  let api = null, last = null, busy = false;
  function renderKits() {
    const cur = HC.state.look.kit;
    $("kitList").innerHTML = HC.KITS.map((k) => `<button class="kit ${cur === k.id ? "on" : ""}" data-kit="${k.id}" title="配色出自 Taste Skill「${k.pal}」">
      <span class="sw" style="background:linear-gradient(135deg,#2a2a2a,#121212)"><b style="color:${k.ink};font-family:'${k.font}';font-weight:${k.weight}">字</b><i style="background:${k.accent}"></i></span>${esc(k.name)}</button>`).join("");
  }
  function renderSources() {
    $("tasteSrc").innerHTML = HC.TASTE_SOURCES.map((s) => `<li class="tsrc"><label class="check"><input type="checkbox" data-src="${s.id}" ${srcOn(s.id) ? "checked" : ""}> <b>${esc(s.name)}</b></label>
      <span class="sub">${esc(s.by)}・<a href="${s.url}" target="_blank" rel="noopener">${esc(s.url.replace(/^https:\/\//, ""))}</a></span>
      <ul>${s.learned.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></li>`).join("");
  }
  function renderCheck() {
    const el = $("tasteResult");
    if (!last) { el.innerHTML = ""; return; }
    const lvName = { bad: "要改", warn: "建議", info: "小細節" };
    el.innerHTML = `<div class="tscore"><b>${last.score}</b> 分 <span class="muted">${last.items.length ? `${last.items.length} 個地方可以更好` : "很好，沒有發現問題"}</span>${last.items.some((x) => x.fix) ? `<button class="btn" id="tasteAll">全部修正</button>` : ""}</div>` +
      last.items.map((x, i) => `<div class="titem ${x.lv}"><span class="lv">${lvName[x.lv]}</span><span class="msg">${esc(x.msg)}<small>${x.src === "skillry" ? "Skillry" : "Taste Skill"}</small></span>${x.fix ? `<button class="btn" data-fix="${i}">${esc(x.fixName || "修正")}</button>` : ""}</div>`).join("");
  }
  async function runCheck() {
    if (busy) return; busy = true;
    $("tasteCheckBtn").disabled = true; $("tasteResult").innerHTML = `<p class="muted">檢查中…</p>`;
    try { last = await HC.tasteCheck(); } finally { busy = false; $("tasteCheckBtn").disabled = false; }
    renderCheck();
  }
  async function deal(silent) {
    const before = JSON.stringify([HC.state.title, HC.state.look.kit, HC.state.texts]);
    const r = await HC.dealKit(); if (!r) return null;
    // 量畫面要幾秒；這段時間你自己改了開頭或文字，就不要蓋掉
    if (silent && before !== JSON.stringify([HC.state.title, HC.state.look.kit, HC.state.texts])) return null;
    HC.commit();
    HC.applyKit(r.kit.id, false);
    $("kitWhy").textContent = `依畫面挑了「${r.kit.name}」（${r.why.join("、")}）。也可以試試「${r.alt.map((k) => k.name).join("」「")}」。`;
    renderKits(); api.changed();
    if (!silent) api.toast(`已套用美感組合「${r.kit.name}」`);
    return r;
  }
  HC.tasteAfterAuto = async () => {
    if (HC.state.auto.taste === false || !srcOn("taste")) return;
    if (!HC.state.look.kit) await deal(true);
    const done = await HC.tasteAuto();
    if (done.length) { api.changed(); api.toast(`已依你的習慣自動修正 ${done.length} 個美感問題`); }
  };
  HC.initTaste = (a) => {
    api = a;
    renderKits(); renderSources();
    $("kitList").addEventListener("click", (e) => {
      const b = e.target.closest("[data-kit]"); if (!b) return;
      HC.commit(); HC.applyKit(b.dataset.kit, true);
      $("kitWhy").textContent = `「${HC.kit(b.dataset.kit).name}」：配色出自 Taste Skill 的「${HC.kit(b.dataset.kit).pal}」。已記住你喜歡這組。`;
      renderKits(); api.changed(); last = null; renderCheck();
    });
    $("kitDeal").onclick = async () => { $("kitDeal").disabled = true; try { await deal(); } finally { $("kitDeal").disabled = false; } };
    $("tasteCheckBtn").onclick = runCheck;
    $("tlTaste").onclick = () => { document.querySelector('[data-tab="title"]').click(); $("tasteBox").scrollIntoView({ block: "start" }); runCheck(); };
    $("tasteResult").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-fix]"), all = e.target.closest("#tasteAll");
      if (!b && !all) return;
      HC.commit();
      const list = all ? last.items.filter((x) => x.fix) : [last.items[+b.dataset.fix]];
      for (const it of list) await HC.tasteFix(it);
      api.changed(); api.toast(all ? `已修正 ${list.length} 項` : "已修正");
      runCheck();
    });
    $("tasteSrc").addEventListener("change", (e) => {
      const c = e.target.closest("[data-src]"); if (!c) return;
      const P = HC.profile; P.tasteSrc = P.tasteSrc || {}; P.tasteSrc[c.dataset.src] = c.checked; HC.saveProfile && HC.saveProfile();
      api.toast(c.checked ? "已啟用這個美感來源" : "已停用這個美感來源（之後的檢查和配色不會用到）");
    });
  };
  HC.renderTaste = () => { if ($("kitList")) { renderKits(); renderSources(); } };
}
