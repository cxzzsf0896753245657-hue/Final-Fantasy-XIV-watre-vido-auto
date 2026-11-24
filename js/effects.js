/* 轉場、濾鏡、特效、開頭／片尾模板
   這個檔案同時給兩個地方用：
   - 網頁裡的預覽與匯出（畫在 canvas 上）
   - 匯出的 HyperFrames 專案（標題與特效畫在疊加的 canvas 上，轉場改用 GSAP 動畫 DOM）
   所以這裡只依賴 GSAP，不碰其他模組；整段包在 installEffects() 裡，匯出 HyperFrames 時直接把這個函式的原始碼放進專案。
   開頭與片尾的動畫用 GSAP 時間軸控制（逐字出現、畫線、縮放），播放時直接 seek 到該時間點，畫面完全可重現。
*/
function installEffects() {
  const HC = (window.HC = window.HC || {});
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const G = () => window.gsap;

  /* ---------- 緩動曲線（有 GSAP 就用 GSAP 的） ---------- */
  const easeCache = {};
  HC.ease = (name) => {
    if (easeCache[name]) return easeCache[name];
    const g = G();
    const f = g && g.parseEase ? g.parseEase(name) : (p) => p * p * (3 - 2 * p);
    return (easeCache[name] = f);
  };

  /* ================= 轉場 ================= */
  HC.TRANSITIONS = [
    { id: "cut", name: "直切", dur: 0 },
    { id: "fade", name: "疊化", dur: 0.8 },
    { id: "slow", name: "慢速淡化", dur: 1.6 },
    { id: "black", name: "黑場", dur: 1.2 },
    { id: "white", name: "白場", dur: 1.0 },
    { id: "blur", name: "模糊", dur: 1.0 },
    { id: "circle", name: "圓形掃描", dur: 1.0 },
    { id: "wipeR", name: "向右擦除", dur: 0.9 },
    { id: "wipeL", name: "向左擦除", dur: 0.9 },
    { id: "push", name: "推移", dur: 0.8 },
    { id: "zoom", name: "縮放穿越", dur: 0.8 },
    { id: "flash", name: "閃白", dur: 0.6 },
  ];
  HC.trInfo = (id) => HC.TRANSITIONS.find((t) => t.id === id) || HC.TRANSITIONS[0];

  // 便宜的模糊：先縮小再放大（不用 ctx.filter，所有瀏覽器都能跑）
  let blurC = null;
  function soft(ctx, src, amount, W, H, alpha) {
    if (amount < 0.5) { ctx.globalAlpha = alpha; ctx.drawImage(src, 0, 0, W, H); ctx.globalAlpha = 1; return; }
    const k = 1 / (1 + amount * 0.55), w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
    blurC = blurC || document.createElement("canvas");
    if (blurC.width !== w || blurC.height !== h) { blurC.width = w; blurC.height = h; }
    const b = blurC.getContext("2d");
    b.imageSmoothingQuality = "high";
    b.drawImage(src, 0, 0, w, h);
    ctx.save(); ctx.imageSmoothingQuality = "high"; ctx.globalAlpha = alpha; ctx.drawImage(blurC, 0, 0, W, H); ctx.restore();
  }

  /* A = 前一個鏡頭畫面、B = 下一個鏡頭畫面（都是 canvas），p = 0→1 */
  HC.drawTransition = (ctx, A, B, p, type, W, H) => {
    const e = HC.ease(type === "slow" ? "sine.inOut" : "power2.inOut")(clamp(p, 0, 1));
    ctx.save();
    switch (type) {
      case "fade": case "slow":
        ctx.drawImage(A, 0, 0); ctx.globalAlpha = e; ctx.drawImage(B, 0, 0); break;
      case "black": case "white": {
        const c = type === "black" ? "0,0,0" : "255,255,255";
        if (e < 0.5) { ctx.drawImage(A, 0, 0); ctx.fillStyle = `rgba(${c},${e * 2})`; }
        else { ctx.drawImage(B, 0, 0); ctx.fillStyle = `rgba(${c},${(1 - e) * 2})`; }
        ctx.fillRect(0, 0, W, H); break;
      }
      case "blur":
        soft(ctx, A, e * 22, W, H, 1);
        soft(ctx, B, (1 - e) * 22, W, H, e); break;
      case "circle":
        ctx.drawImage(A, 0, 0);
        ctx.beginPath(); ctx.arc(W / 2, H / 2, e * Math.hypot(W, H) / 2 + 1, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(B, 0, 0); break;
      case "wipeR": case "wipeL": {
        ctx.drawImage(A, 0, 0);
        const x = type === "wipeR" ? 0 : W * (1 - e);
        ctx.beginPath(); ctx.rect(x, 0, W * e, H); ctx.clip(); ctx.drawImage(B, 0, 0); break;
      }
      case "push":
        ctx.drawImage(A, -e * W, 0); ctx.drawImage(B, (1 - e) * W, 0); break;
      case "zoom": {
        const s1 = 1 + 0.35 * e, s2 = 1.25 - 0.25 * e;
        ctx.drawImage(A, W / 2 - (W * s1) / 2, H / 2 - (H * s1) / 2, W * s1, H * s1);
        ctx.globalAlpha = e; ctx.drawImage(B, W / 2 - (W * s2) / 2, H / 2 - (H * s2) / 2, W * s2, H * s2); break;
      }
      case "flash":
        ctx.drawImage(e < 0.5 ? A : B, 0, 0);
        ctx.fillStyle = `rgba(255,255,255,${Math.sin(Math.PI * e) * 0.85})`; ctx.fillRect(0, 0, W, H); break;
      default:
        ctx.drawImage(p < 0.5 ? A : B, 0, 0);
    }
    ctx.restore();
  };

  /* HyperFrames 版：用 GSAP 動畫兩個鏡頭的外框（out、in 是 DOM 元素，ov 是全畫面的色塊） */
  HC.hfTransition = (tl, out, inn, ov, t0, d, type) => {
    const io = { duration: d, ease: type === "slow" ? "sine.inOut" : "power2.inOut" };
    switch (type) {
      case "fade": case "slow": tl.fromTo(inn, { opacity: 0 }, { opacity: 1, ...io }, t0); break;
      case "black": case "white":
        tl.set(ov, { backgroundColor: type === "black" ? "#000" : "#fff" }, t0);
        tl.fromTo(ov, { opacity: 0 }, { opacity: 1, duration: d / 2, ease: "power1.in", immediateRender: false }, t0);
        tl.fromTo(inn, { opacity: 0 }, { opacity: 1, duration: 0.001 }, t0 + d / 2);
        tl.to(ov, { opacity: 0, duration: d / 2, ease: "power1.out" }, t0 + d / 2); break;
      case "blur":
        tl.fromTo(out, { filter: "blur(0px)" }, { filter: "blur(18px)", ...io, immediateRender: false }, t0);
        tl.fromTo(inn, { opacity: 0, filter: "blur(18px)" }, { opacity: 1, filter: "blur(0px)", ...io }, t0); break;
      case "circle": tl.fromTo(inn, { clipPath: "circle(0% at 50% 50%)" }, { clipPath: "circle(75% at 50% 50%)", ...io }, t0); break;
      case "wipeR": tl.fromTo(inn, { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", ...io }, t0); break;
      case "wipeL": tl.fromTo(inn, { clipPath: "inset(0% 0% 0% 100%)" }, { clipPath: "inset(0% 0% 0% 0%)", ...io }, t0); break;
      case "push":
        tl.fromTo(out, { xPercent: 0 }, { xPercent: -100, ...io, immediateRender: false }, t0);
        tl.fromTo(inn, { xPercent: 100 }, { xPercent: 0, ...io }, t0); break;
      case "zoom":
        tl.fromTo(out, { scale: 1 }, { scale: 1.35, ...io, immediateRender: false }, t0);
        tl.fromTo(inn, { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, ...io }, t0); break;
      case "flash":
        tl.set(ov, { backgroundColor: "#fff" }, t0);
        tl.fromTo(ov, { opacity: 0 }, { opacity: 0.85, duration: d / 2, ease: "sine.in", immediateRender: false }, t0);
        tl.fromTo(inn, { opacity: 0 }, { opacity: 1, duration: 0.001 }, t0 + d / 2);
        tl.to(ov, { opacity: 0, duration: d / 2, ease: "sine.out" }, t0 + d / 2); break;
    }
  };

  /* ================= 濾鏡 ================= */
  HC.FILTERS = [
    { id: "none", name: "原色", css: "" },
    { id: "fresh", name: "清新", css: "brightness(1.05) saturate(1.18) contrast(1.02)" },
    { id: "warm", name: "暖陽", css: "saturate(1.08) sepia(0.16) brightness(1.03)", tint: "rgba(255,170,90,0.10)" },
    { id: "cool", name: "冷調", css: "saturate(0.92) hue-rotate(-8deg) brightness(1.02)", tint: "rgba(90,150,255,0.10)" },
    { id: "film", name: "電影感", css: "contrast(1.12) saturate(0.85) brightness(0.97)", tint: "rgba(0,120,140,0.08)" },
    { id: "retro", name: "復古", css: "sepia(0.35) contrast(1.05) saturate(0.8)" },
    { id: "night", name: "夜晚", css: "brightness(0.9) saturate(0.85) hue-rotate(-12deg) contrast(1.06)", tint: "rgba(40,60,140,0.12)" },
    { id: "dream", name: "夢幻", css: "brightness(1.08) saturate(1.2) contrast(0.92)", tint: "rgba(255,160,220,0.08)" },
    { id: "cream", name: "奶油", css: "brightness(1.06) contrast(0.9) saturate(0.9) sepia(0.1)" },
    { id: "bw", name: "黑白", css: "grayscale(1) contrast(1.1)" },
  ];
  HC.filterInfo = (id) => HC.FILTERS.find((f) => f.id === id) || HC.FILTERS[0];
  HC.canFilter = (() => { try { const c = document.createElement("canvas").getContext("2d"); return typeof c.filter === "string"; } catch (e) { return false; } })();

  /* ================= 特效（疊在畫面上的那一層） ================= */
  HC.EFFECTS = [
    { id: "vignette", name: "暗角" },
    { id: "glow", name: "柔光" },
    { id: "bokeh", name: "飄浮光點" },
    { id: "petals", name: "落花" },
    { id: "grain", name: "底片顆粒" },
    { id: "letterbox", name: "電影黑邊" },
  ];
  const rnd = (s) => () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  const pts = (() => { const r = rnd(7), a = []; for (let i = 0; i < 60; i++) a.push([r(), r(), r(), r(), r()]); return a; })();
  let grainTiles = null;
  function grain() {
    if (grainTiles) return grainTiles;
    grainTiles = [0, 1, 2, 3].map((k) => {
      const c = document.createElement("canvas"); c.width = c.height = 256;
      const g = c.getContext("2d"), d = g.createImageData(256, 256), r = rnd(11 + k);
      for (let i = 0; i < d.data.length; i += 4) { const v = r() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
      g.putImageData(d, 0, 0); return c;
    });
    return grainTiles;
  }
  let glowC = null;
  /* fx：{vignette:0~1, ...}，frame：目前畫面（柔光要用，HyperFrames 的疊加層沒有，會略過） */
  HC.drawEffects = (ctx, W, H, T, fx, frame) => {
    if (!fx) return;
    const u = H / 1080;
    if (fx.glow && frame) {
      glowC = glowC || document.createElement("canvas");
      glowC.width = Math.round(W / 6); glowC.height = Math.round(H / 6);
      glowC.getContext("2d").drawImage(frame, 0, 0, glowC.width, glowC.height);
      ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = 0.45 * fx.glow; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(glowC, 0, 0, W, H); ctx.restore();
    }
    if (fx.bokeh) {
      ctx.save(); ctx.globalCompositeOperation = "screen";
      for (let i = 0; i < 26; i++) {
        const [a, b, c, d, e] = pts[i];
        const x = ((a * W + Math.sin(T * (0.2 + c * 0.3) + d * 6) * 60 * u) % W + W) % W;
        const y = (((b * H - T * (12 + c * 25) * u) % H) + H) % H, r = (8 + e * 22) * u;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255,236,190,${0.55 * fx.bokeh * (0.4 + 0.6 * Math.abs(Math.sin(T * 0.8 + d * 9)))})`);
        g.addColorStop(1, "rgba(255,236,190,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
    if (fx.petals) {
      ctx.save();
      for (let i = 0; i < 34; i++) {
        const [a, b, c, d, e] = pts[i + 20];
        const fall = 40 + c * 60, y = ((b * H + T * fall * u) % (H + 40 * u)) - 20 * u;
        const x = ((a * W + Math.sin(T * (0.6 + d) + e * 7) * 50 * u + T * 15 * u) % W + W) % W;
        ctx.save(); ctx.translate(x, y); ctx.rotate(T * (0.8 + e * 2) + d * 6); ctx.scale(1, 0.55 + 0.45 * Math.abs(Math.sin(T * 2 + a * 9)));
        ctx.globalAlpha = 0.75 * fx.petals;
        ctx.fillStyle = i % 3 ? "#f5b8d0" : "#d9a6f0";
        ctx.beginPath(); ctx.ellipse(0, 0, (6 + e * 6) * u, (3.5 + e * 3) * u, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }
    if (fx.grain) {
      const tiles = grain(), tile = tiles[Math.floor(T * 24) % 4];
      ctx.save(); ctx.globalCompositeOperation = "overlay"; ctx.globalAlpha = 0.16 * fx.grain;
      ctx.fillStyle = ctx.createPattern(tile, "repeat"); ctx.fillRect(0, 0, W, H); ctx.restore();
    }
    if (fx.vignette) {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,0,${0.7 * fx.vignette})`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (fx.letterbox) { const h = H * 0.1 * fx.letterbox; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, h); ctx.fillRect(0, H - h, W, h); }
  };

  /* ================= 開頭／片尾模板（GSAP 時間軸） =================
     每個模板只描述「動畫」：哪些字、線、色塊在什麼時間怎麼動。
     g.main / g.sub / g.info 是每個字的目標物件（有 opacity、x、y、scale），
     g.group 是整組，g.line 是標題下的線（scaleX），g.bar 是資訊卡的直線（scaleY），
     g.bars 是電影黑邊（scaleY），g.cursor 是打字機游標。 */
  const all = (g) => [...g.main, ...g.sub, ...g.info];
  const exit = (tl, g, d, keep) => { if (!keep) tl.to(g.group, { opacity: 0, duration: 0.8, ease: "power1.in" }, Math.max(0.5, d - 0.8)); };
  HC.TITLE_TEMPLATES = [
    { id: "classic", name: "經典置中", layout: "center", line: true, build(tl, g, d, keep) {
        tl.from(g.main, { opacity: 0, y: 24, duration: 1, ease: "power2.out" }, 0.8);
        tl.from(g.line, { scaleX: 0, duration: 0.9, ease: "power2.inOut" }, 1.3);
        tl.from([...g.sub, ...g.info], { opacity: 0, y: 12, duration: 0.8, ease: "power2.out" }, 1.6);
        exit(tl, g, d, keep);
      } },
    { id: "rise", name: "逐字浮現", layout: "center", build(tl, g, d, keep) {
        tl.from(g.main, { opacity: 0, y: 50, duration: 0.7, ease: "back.out(1.7)", stagger: 0.07 }, 0.6);
        const t2 = 0.8 + g.main.length * 0.07;
        tl.from(g.sub, { opacity: 0, y: 18, duration: 0.5, ease: "power2.out", stagger: 0.035 }, t2);
        tl.from(g.info, { opacity: 0, y: 12, duration: 0.5, ease: "power2.out", stagger: 0.02 }, t2 + 0.4);
        exit(tl, g, d, keep);
      } },
    { id: "underline", name: "畫線強調", layout: "center", line: true, accentLine: true, build(tl, g, d, keep) {
        tl.from(g.main, { opacity: 0, y: 20, duration: 0.8, ease: "power2.out", stagger: 0.03 }, 0.6);
        tl.from(g.line, { scaleX: 0, duration: 1.0, ease: "power3.inOut" }, 1.5);
        tl.from([...g.sub, ...g.info], { opacity: 0, duration: 0.7 }, 2.2);
        exit(tl, g, d, keep);
      } },
    { id: "cinema", name: "電影黑邊", layout: "cinema", bars: true, build(tl, g, d, keep) {
        tl.from(g.bars, { scaleY: 0, duration: 1.0, ease: "power2.out" }, 0);
        const mid = (g.main.length - 1) / 2;
        g.main.forEach((c, i) => tl.from(c, { opacity: 0, x: (i - mid) * 22, duration: 1.8, ease: "power3.out" }, 0.8));
        tl.from([...g.sub, ...g.info], { opacity: 0, y: 8, duration: 0.8 }, 1.9);
        if (!keep) { tl.to(g.group, { opacity: 0, duration: 0.8 }, Math.max(0.5, d - 0.8)); tl.to(g.bars, { scaleY: 0, duration: 0.8, ease: "power2.in" }, Math.max(0.5, d - 0.5)); }
      } },
    { id: "typewriter", name: "打字機", layout: "left", cursor: true, build(tl, g, d, keep) {
        tl.from(g.main, { opacity: 0, duration: 0.01, stagger: 0.09 }, 0.6);
        const t2 = 0.8 + g.main.length * 0.09;
        tl.from(g.sub, { opacity: 0, duration: 0.01, stagger: 0.05 }, t2);
        tl.from(g.info, { opacity: 0, duration: 0.01, stagger: 0.03 }, t2 + 0.2 + g.sub.length * 0.05);
        tl.to(g.cursor, { opacity: 0, duration: 0.3, repeat: Math.max(1, Math.floor(d / 0.6)), yoyo: true, ease: "steps(1)" }, 0);
        exit(tl, g, d, keep);
      } },
    { id: "infocard", name: "左下資訊卡", layout: "lowleft", bar: true, build(tl, g, d, keep) {
        tl.from(g.bar, { scaleY: 0, duration: 0.7, ease: "power2.out" }, 0.5);
        tl.from(g.main, { opacity: 0, x: -30, duration: 0.6, ease: "power2.out", stagger: 0.025 }, 0.8);
        tl.from(g.sub, { opacity: 0, x: -20, duration: 0.6, ease: "power2.out" }, 1.3);
        tl.from(g.info, { opacity: 0, x: -20, duration: 0.6, ease: "power2.out" }, 1.55);
        if (!keep) tl.to(g.group, { opacity: 0, x: -20, duration: 0.7, ease: "power1.in" }, Math.max(0.5, d - 0.7));
      } },
    { id: "zoom", name: "大字縮放", layout: "center", build(tl, g, d, keep) {
        tl.from(g.group, { scale: 1.4, opacity: 0, duration: 1.6, ease: "expo.out" }, 0.6);
        tl.from([...g.sub, ...g.info], { opacity: 0, duration: 0.8 }, 1.6);
        exit(tl, g, d, keep);
      } },
    { id: "none", name: "不顯示", layout: "center", build() {} },
  ];
  HC.titleTpl = (id) => HC.TITLE_TEMPLATES.find((t) => t.id === id) || HC.TITLE_TEMPLATES[0];

  /* 版面：算出每個字的位置（canvas 用） */
  function layout(ctx, W, H, o, tpl) {
    const u = H / 1080, size = o.size * u, sub = Math.round(size * 0.43), info = Math.round(size * 0.32);
    const font = (w, s) => `${w} ${s}px "${o.font}", "Noto Serif TC", serif`;
    const lines = [];
    const mk = (text, w, s) => { ctx.font = font(w, s); const chars = [...(text || "")]; let x = 0; const out = chars.map((ch) => { const c = { ch, x0: x }; x += ctx.measureText(ch).width; return c; }); return { chars: out, width: x, font: font(w, s), size: s }; };
    const L1 = mk(o.main, 600, size), L2 = mk(o.sub, 400, sub), L3 = mk(o.info, 400, info);
    let x, y, align = "center";
    switch (tpl.layout) {
      case "lowleft": x = W * 0.07; y = H * 0.70; align = "left"; break;
      case "left": x = W * 0.09; y = H * 0.44; align = "left"; break;
      case "cinema": x = W / 2; y = H * 0.74; break;
      default: x = W / 2; y = o.pos === "top" ? H * 0.2 : o.pos === "lowleft" ? H * 0.72 : H * 0.42; if (o.pos === "lowleft") { x = W * 0.07; align = "left"; }
    }
    const left = (L) => align === "left" ? x : x - L.width / 2;
    lines.push({ ...L1, x: left(L1), y });
    let yy = y + size * 0.55;
    const lineY = yy;
    if (tpl.line || o.line) yy += sub * 0.6;
    lines.push({ ...L2, x: left(L2), y: yy + sub });
    if (L2.chars.length) yy += sub * 1.5;
    lines.push({ ...L3, x: left(L3), y: yy + info * 1.1 });
    const lw = Math.min(W * 0.6, Math.max(L1.width * 1.1, 200 * u));
    return { lines, align, x, y, size, u, line: { x: align === "left" ? x : x - lw / 2, y: lineY, w: lw, h: (tpl.accentLine ? 5 : 2) * u }, bar: { x: x - 22 * u, y: y - size * 0.95, h: (yy + info * 1.6) - (y - size * 0.95) } };
  }

  /* 建立（或沿用）某一組文字的 GSAP 時間軸 */
  const tlCache = new Map();
  function getTimeline(key, o, tpl, d, keep, L) {
    const hit = tlCache.get(key);
    if (hit) return hit;
    const mkT = (arr) => arr.map(() => ({ opacity: 1, x: 0, y: 0, scale: 1 }));
    const g = { main: mkT(L.lines[0].chars), sub: mkT(L.lines[1].chars), info: mkT(L.lines[2].chars),
      group: { opacity: 1, scale: 1, x: 0, y: 0 }, line: { scaleX: 1, opacity: 1 }, bar: { scaleY: 1 }, bars: { scaleY: 1 }, cursor: { opacity: 1 } };
    let tl = null;
    if (G()) {
      tl = G().timeline({ paused: true });
      // 空的目標（例如沒有副標）直接略過，GSAP 才不會報錯
      const empty = (t) => Array.isArray(t) && !t.flat().length;
      const w = { from: (t, v, p) => (empty(t) ? w : (tl.from(t, v, p), w)), to: (t, v, p) => (empty(t) ? w : (tl.to(t, v, p), w)), set: (t, v, p) => (empty(t) ? w : (tl.set(t, v, p), w)), fromTo: (t, a, b, p) => (empty(t) ? w : (tl.fromTo(t, a, b, p), w)) };
      tpl.build(w, g, d, keep);
      tl.seek(0);
    }
    const v = { tl, g };
    tlCache.set(key, v);
    if (tlCache.size > 12) tlCache.delete(tlCache.keys().next().value);
    return v;
  }

  /* 畫一組文字（開頭或片尾），t = 從這組文字開始算的秒數 */
  HC.drawTitleBlock = (ctx, W, H, t, o, keep) => {
    const tpl = HC.titleTpl(o.template);
    if (tpl.id === "none" || !o.main) return;
    const d = o.dur;
    if (!keep && t > d + 0.1) return;
    const L = layout(ctx, W, H, o, tpl);
    const key = JSON.stringify([o.template, o.main, o.sub, o.info, o.font, o.size, o.pos, o.line, d, keep, W, H]);
    const { tl, g } = getTimeline(key, o, tpl, d, keep, L);
    if (tl) tl.seek(clamp(t, 0, tl.duration() || d));
    else { const a = clamp(Math.min(t - 0.6, keep ? 1 : d - t), 0, 1); g.group.opacity = a; }
    const u = L.u, G0 = g.group;
    if (tpl.bars) { const h = H * 0.11 * g.bars.scaleY; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, h); ctx.fillRect(0, H - h, W, h); }
    if (G0.opacity <= 0.001) return;
    ctx.save();
    const cx = L.align === "left" ? L.x : W / 2, cy = L.y - L.size * 0.3;
    ctx.translate(cx + G0.x * u, cy + G0.y * u); ctx.scale(G0.scale, G0.scale); ctx.translate(-cx, -cy);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    ctx.shadowColor = "rgba(0,0,0,.55)"; ctx.shadowBlur = 8 * u; ctx.shadowOffsetX = 2 * u; ctx.shadowOffsetY = 2 * u;
    ctx.fillStyle = o.color || "#fff";
    if (tpl.line || o.line) {
      if (tpl.id !== "infocard" && tpl.id !== "typewriter" && g.line.scaleX > 0.001) {
        ctx.globalAlpha = G0.opacity * 0.9;
        const ln = L.line, w = ln.w * g.line.scaleX;
        ctx.fillStyle = tpl.accentLine ? (o.accent || "#e9c46a") : (o.color || "#fff");
        ctx.fillRect(L.align === "left" ? ln.x : ln.x + (ln.w - w) / 2 * (tpl.accentLine ? 0 : 1), ln.y, w, ln.h);
        ctx.fillStyle = o.color || "#fff";
      }
    }
    if (tpl.bar && g.bar.scaleY > 0.001) { ctx.globalAlpha = G0.opacity; ctx.fillStyle = o.accent || "#e9c46a"; ctx.fillRect(L.bar.x, L.bar.y, 4 * u, L.bar.h * g.bar.scaleY); ctx.fillStyle = o.color || "#fff"; }
    const groups = [g.main, g.sub, g.info];
    let lastX = null, lastY = null;
    L.lines.forEach((ln, li) => {
      const tg = groups[li] || [];
      ctx.font = ln.font;
      ln.chars.forEach((c, i) => {
        const s = tg[i]; if (!s || s.opacity <= 0.001) return;
        ctx.globalAlpha = G0.opacity * s.opacity;
        const x = ln.x + c.x0 + s.x * u, y = ln.y + s.y * u;
        if (s.scale !== 1) { ctx.save(); ctx.translate(x, y); ctx.scale(s.scale, s.scale); ctx.fillText(c.ch, 0, 0); ctx.restore(); }
        else ctx.fillText(c.ch, x, y);
        if (s.opacity > 0.5) { lastX = x + ctx.measureText(c.ch).width; lastY = ln.y; }
      });
    });
    if (tpl.cursor && lastX != null && g.cursor.opacity > 0.5) { ctx.globalAlpha = G0.opacity; ctx.fillRect(lastX + 6 * u, lastY - L.size * 0.8, 4 * u, L.size * 0.9); }
    ctx.restore();
  };

  /* 鏡頭上的文字（例如「夜」「臥室」） */
  HC.drawCaption = (ctx, W, H, text, lt, od, font) => {
    const a = lt < 0.6 ? 0 : lt < 1.3 ? (lt - 0.6) / 0.7 : lt < od - 0.4 - 0.7 ? 1 : lt < od - 0.4 ? (od - 0.4 - lt) / 0.7 : 0;
    if (a <= 0) return;
    const u = H / 1080;
    ctx.save();
    ctx.globalAlpha = a * 0.92; ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 8 * u; ctx.shadowOffsetX = 2 * u; ctx.shadowOffsetY = 2 * u;
    ctx.fillStyle = "#fff"; ctx.font = `500 ${88 * u}px "${font}", serif`;
    ctx.fillText(text, W / 2, H * 0.47);
    ctx.restore();
  };

  /* 整個疊加層：特效 → 片頭片尾黑場 → 鏡頭文字 → 開頭 → 片尾
     info = { T, total, fi, fo, look, title, ending, captions:[{text,start,dur}] } */
  HC.drawOverlay = (ctx, W, H, info, frame) => {
    const { T, total } = info;
    HC.drawEffects(ctx, W, H, T, info.look && info.look.fx, frame);
    if (info.look && info.look.filter) { const f = HC.filterInfo(info.look.filter); if (f.tint) { ctx.save(); ctx.globalCompositeOperation = "soft-light"; ctx.fillStyle = f.tint.replace(/[\d.]+\)$/, (m) => Math.min(1, parseFloat(m) * 3) + ")"); ctx.fillRect(0, 0, W, H); ctx.restore(); } }
    for (const c of info.captions || []) if (T >= c.start && T < c.start + c.dur) HC.drawCaption(ctx, W, H, c.text, T - c.start, c.dur, info.title.font);
    if (info.title && info.title.show) HC.drawTitleBlock(ctx, W, H, T, info.title, false);
    const E = info.ending;
    if (E && E.template !== "none" && E.main) {
      const st = Math.max(0, total - E.dur - (info.fo || 0) * 0.5);
      if (T >= st) HC.drawTitleBlock(ctx, W, H, T - st, { ...info.title, ...E, info: E.info || "" }, true);
    }
    let black = 0;
    if (info.fi > 0 && T < info.fi) black = 1 - T / info.fi;
    if (info.fo > 0 && T > total - info.fo) black = Math.max(black, 1 - (total - T) / info.fo);
    if (black > 0.001) { ctx.fillStyle = `rgba(0,0,0,${clamp(black, 0, 1)})`; ctx.fillRect(0, 0, W, H); }
  };
}
installEffects();
window.HC.effectsSource = installEffects.toString();
