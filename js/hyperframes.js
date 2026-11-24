/* 匯出 HyperFrames 專案
   HyperFrames（HeyGen 開源）用 HTML 描述影片，再用無頭 Chrome 逐格渲染成 MP4：
   不會掉格、畫質最好，也能在 HyperFrames Studio 裡繼續編輯。
   產生的專案：
   - index.html：每個鏡頭是一個 <video>（data-start / data-duration / data-media-start / data-playback-rate），
     外面包三層 div：轉場（GSAP 動畫）→ 防抖位移 → 推近／平移
   - 標題、片尾、鏡頭文字、特效、濾鏡色調畫在最上層的 canvas，用的是和網頁同一份 effects.js 程式，由 GSAP 時間軸驅動
   - assets/：用到的素材與背景音樂
*/
{
  const HC = window.HC;
  const GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js";
  const HF_VER = "0.9.88";
  let W = 1920, H = 1080;   // 打包時依「匯出」分頁的畫面比例決定

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const extOf = (name, fb) => { const m = /\.([a-z0-9]{2,4})$/i.exec(name || ""); return m ? m[1].toLowerCase() : fb; };

  /* 推近／平移在 DOM 裡的寫法：kb 這層的 scale、x、y（起點與終點） */
  function kenBurns(s) {
    const k = s.zoom || 0, z = 1 + k;
    const span = (zz, L) => (zz - 1) * L / 2;
    switch (s.mode) {
      case "in": return [{ scale: 1 }, { scale: z }];
      case "out": return [{ scale: z }, { scale: 1 }];
      case "panR": return [{ scale: z, x: span(z, W) }, { scale: z, x: -span(z, W) }];
      case "panL": return [{ scale: z, x: -span(z, W) }, { scale: z, x: span(z, W) }];
      case "panU": return [{ scale: z, y: -span(z, H) }, { scale: z, y: span(z, H) }];
      case "panD": return [{ scale: z, y: span(z, H) }, { scale: z, y: -span(z, H) }];
      case "none": return [{ scale: z }, { scale: z }];
      default: return null;
    }
  }

  /* 直式時平移改成移動 object-position（橫式素材在直式畫面裡左右有很多可以移） */
  function panPos(s) {
    if (W >= H) return null;
    const [fx, fy] = HC.focusOf(s).map((v) => Math.round(v * 100));
    switch (s.mode) {
      case "panR": return [`0% ${fy}%`, `100% ${fy}%`];
      case "panL": return [`100% ${fy}%`, `0% ${fy}%`];
      default: return null;
    }
  }
  HC.buildHyperframes = async ({ includeClips = true, name = "housing", onProgress } = {}) => {
    ({ W, H } = HC.outSize(1080));
    // 素材（16:9）蓋滿畫面後的實際大小：防抖位移要用這個換算成像素
    const DW = Math.max(W, H * 16 / 9), DH = Math.max(H, W * 9 / 16);
    const S = HC.state, { starts, total } = HC.timeline();
    const shots = S.shots;
    const used = [...new Set(shots.map((s) => s.clipId))].map((id) => HC.clip(id));
    const fileOf = new Map(used.map((c, i) => [c.id, `assets/clip${String(i + 1).padStart(2, "0")}.${extOf(c.name, "mp4")}`]));
    const hasMusic = !!S.music.url;
    const musicFile = hasMusic ? `assets/music.${extOf(S.music.name, "mp3")}` : null;

    // 防抖：每個鏡頭每 1/30 秒的補償位移
    const stabKeys = {};
    shots.forEach((s, i) => {
      if (!s.stab || !HC.stabReady(s)) return;
      const crop = HC.stabCrop(s), keys = [];
      for (let t = 0; t <= HC.outDur(s) + 1e-6; t += 1 / 30) {
        const o = HC.stabOffset(s, s.start + t * s.speed);
        if (o) keys.push([r3(t), Math.round(-o[0] * DW * crop * 10) / 10, Math.round(-o[1] * DH * crop * 10) / 10]);
      }
      stabKeys[i] = { crop: r3(crop), keys };
    });

    const info = { ...HC.R.overlayInfo(0) };
    delete info.T;
    const fonts = [S.title.font, "Noto Serif TC"];
    const textForFonts = [S.title.main, S.title.sub, S.title.info, S.ending.main, S.ending.sub, ...shots.map((s) => s.text || "")].join("");

    const clipsHtml = shots.map((s, i) => {
      const f = HC.filterCss(s.filter || S.look.filter, S.look.filterStr ?? 1);
      let [fx, fy] = HC.focusOf(s).map((v) => r3(v * 100));
      if (s.mode === "panR" || s.mode === "panL") fx = 50;   // 平移時，移動方向用置中當縮放中心
      if (s.mode === "panU" || s.mode === "panD") fy = 50;
      // 目標點：縮放的中心（transform-origin），直式時也決定保留哪一塊（object-position）
      return `  <div class="frame" id="f${i}" style="z-index:${i + 1}"><div class="stab" id="s${i}"><div class="kb" id="k${i}" style="transform-origin:${fx}% ${fy}%">
    <video id="v${i}" class="clip" data-start="${r3(starts[i])}" data-duration="${r3(HC.outDur(s))}" data-track-index="${i % 2}" data-media-start="${r3(s.start)}" data-playback-rate="${s.speed}" src="${fileOf.get(s.clipId)}" muted playsinline style="object-position:${fx}% ${fy}%${f ? `;filter:${f}` : ""}"></video>
  </div></div></div>`;
    }).join("\n");

    const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=${W}, height=${H}" />
<title>${esc(name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=Noto+Serif+TC:wght@400;500;600&family=LXGW+WenKai+TC&display=swap" rel="stylesheet" />
<script src="${GSAP_URL}"></script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
#root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #000; }
.frame, .stab, .kb { position: absolute; inset: 0; }
.frame { overflow: hidden; }
.kb video { width: 100%; height: 100%; object-fit: cover; display: block; }
#trov { position: absolute; inset: 0; background: #000; opacity: 0; z-index: 9000; pointer-events: none; }
#ov { position: absolute; inset: 0; width: ${W}px; height: ${H}px; z-index: 9500; pointer-events: none; }
</style>
</head>
<body>
<div id="root" data-composition-id="housing" data-start="0" data-duration="${r3(total)}" data-width="${W}" data-height="${H}">
${clipsHtml}
  <div id="trov"></div>
  <canvas id="ov" class="clip" data-start="0" data-duration="${r3(total)}" data-track-index="3" width="${W}" height="${H}"></canvas>
${hasMusic ? `  <audio id="music" data-start="0" data-duration="${r3(total)}" data-track-index="4" data-media-start="${r3(S.music.off)}" data-volume="${S.music.vol}" data-fade-in="0.5" data-fade-out="${S.music.fade}" src="${musicFile}"></audio>` : ""}
</div>
<script>
/* 轉場、濾鏡、特效、開頭／片尾：和「房屋影片自動剪輯」網頁同一份程式 */
(${HC.effectsSource})();
</script>
<script>
const SHOTS = ${JSON.stringify(shots.map((s, i) => ({ start: r3(starts[i]), dur: r3(HC.outDur(s)), kb: kenBurns(s), op: panPos(s), tr: i && s.tr && s.tr.type !== "cut" ? { type: s.tr.type, dur: r3(HC.trDur(i)) } : null })))};
const STAB = ${JSON.stringify(stabKeys)};
const INFO = ${JSON.stringify(info).replace(/</g, "\\u003c")};
const FONTS = ${JSON.stringify(fonts)};
const TEXT = ${JSON.stringify(textForFonts).replace(/</g, "\\u003c")};

function build() {
  const tl = gsap.timeline({ paused: true });
  SHOTS.forEach((s, i) => {
    // 推近／平移
    if (s.kb) tl.fromTo("#k" + i, s.kb[0], { ...s.kb[1], duration: s.dur, ease: "sine.inOut" }, s.start);
    // 直式畫面的平移：素材比畫面寬很多，改成移動「保留哪一塊」
    if (s.op) tl.fromTo("#v" + i, { objectPosition: s.op[0] }, { objectPosition: s.op[1], duration: s.dur, ease: "sine.inOut" }, s.start);
    // 防抖：放大一點，再逐格位移抵銷晃動
    const st = STAB[i];
    if (st) {
      tl.set("#s" + i, { scale: st.crop, x: st.keys[0][1], y: st.keys[0][2] }, s.start);
      for (let k = 1; k < st.keys.length; k++) tl.to("#s" + i, { x: st.keys[k][1], y: st.keys[k][2], duration: st.keys[k][0] - st.keys[k - 1][0], ease: "none" }, s.start + st.keys[k - 1][0]);
    }
    // 轉場（這個鏡頭進場）
    if (s.tr) HC.hfTransition(tl, "#f" + (i - 1), "#f" + i, "#trov", s.start, s.tr.dur, s.tr.type);
  });
  // 疊加層：每次時間軸被 seek 到某一格，就用同一份程式重畫標題與特效
  const ctx = document.getElementById("ov").getContext("2d");
  const clock = { t: 0 };
  tl.fromTo(clock, { t: 0 }, { t: INFO.total, duration: INFO.total, ease: "none", onUpdate: () => {
    ctx.clearRect(0, 0, ${W}, ${H});
    HC.drawOverlay(ctx, ${W}, ${H}, { ...INFO, T: clock.t }, null);
  } }, 0);
  window.__timelines = window.__timelines || {};
  window.__timelines["housing"] = tl;
  tl.seek(0);
}
// 等字型載入完才註冊時間軸，第一格的標題字型才會正確
Promise.all(FONTS.map((f) => document.fonts.load('600 84px "' + f + '"', TEXT || "A"))).catch(() => {}).then(build);
</script>
</body>
</html>
`;

    const readme = `# ${name}（HyperFrames 專案）

由「房屋影片自動剪輯」網頁匯出。用 HyperFrames 在你的電腦上逐格渲染：不會掉格、畫質最好。

## 第一次使用

1. 安裝 [Node.js 22 以上](https://nodejs.org/) 與 [FFmpeg](https://ffmpeg.org/download.html)
2. 解壓縮這個資料夾，在資料夾裡開啟終端機（Windows：在資料夾空白處按右鍵 →「在終端機中開啟」）
3. 預覽：\`npx hyperframes@${HF_VER} preview\`
4. 輸出影片：\`npx hyperframes@${HF_VER} render -o ${name}.mp4\`
   - 想更快先看效果：加 \`-q draft\`
   - 最高畫質：加 \`-q delivery\`

${includeClips ? "素材已放在 assets/ 裡。" : "**這份匯出沒有包含素材**，請把下表的原始檔複製到 assets/，並改成右邊的檔名：\n"}
| 原始檔名 | 專案裡的檔名 |
|---|---|
${used.map((c) => `| ${c.name} | ${fileOf.get(c.id)} |`).join("\n")}
${hasMusic ? `| ${S.music.name} | ${musicFile} |` : ""}

## 想再修改

- 回到網頁修改後重新匯出最簡單。
- 也可以直接改 index.html：每個鏡頭是一個 \`<video>\`，\`data-start\` 是在成品裡的開始秒數、\`data-media-start\` 是從素材第幾秒開始、\`data-playback-rate\` 是播放速度。
- 標題、片尾、特效的設定在 index.html 下方的 \`INFO\`。
`;

    const files = [
      { name: "index.html", data: html },
      { name: "README.md", data: readme },
      { name: "meta.json", data: JSON.stringify({ id: "housing", name, createdAt: new Date().toISOString() }, null, 2) },
      { name: "hyperframes.json", data: JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2) },
      { name: "package.json", data: JSON.stringify({ name: "housing-video", private: true, type: "module", scripts: { dev: `npx --yes hyperframes@${HF_VER} preview`, check: `npx --yes hyperframes@${HF_VER} check`, render: `npx --yes hyperframes@${HF_VER} render` } }, null, 2) },
    ];
    if (includeClips) {
      for (const c of used) files.push({ name: fileOf.get(c.id), data: c.file || (await (await fetch(c.url)).blob()) });
      if (hasMusic) files.push({ name: musicFile, data: S.music.file || (await (await fetch(S.music.url)).blob()) });
    }
    const root = name.replace(/[\\/:*?"<>|]/g, "_") + "-hyperframes/";
    return zip(files.map((f) => ({ ...f, name: root + f.name })), onProgress);
  };

  /* ---------- 簡單的 zip（不壓縮，影片本來就壓縮過了） ---------- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  async function crcOf(blob, onChunk) {
    let c = 0xffffffff;
    const step = 8 << 20;
    for (let o = 0; o < blob.size; o += step) {
      const b = new Uint8Array(await blob.slice(o, o + step).arrayBuffer());
      for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
      onChunk && onChunk(b.length);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  async function zip(entries, onProgress) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0, done = 0;
    const items = entries.map((e) => ({ ...e, blob: typeof e.data === "string" ? new Blob([enc.encode(e.data)]) : e.data }));
    const totalBytes = items.reduce((a, e) => a + e.blob.size, 0) || 1;
    for (const e of items) {
      const nameB = enc.encode(e.name);
      const crc = await crcOf(e.blob, (n) => { done += n; onProgress && onProgress(done / totalBytes); });
      const size = e.blob.size;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, nameB.length, true);
      parts.push(lh.buffer, nameB, e.blob);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, nameB.length, true); ch.setUint32(42, offset, true);
      central.push(ch.buffer, nameB);
      offset += 30 + nameB.length + size;
    }
    const cdSize = central.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, items.length, true); end.setUint16(10, items.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  }
}
