/* 介面：素材區、預覽、設定分頁、時間軸、專案存檔與匯出 */
{
  const HC = window.HC, R = HC.R, S = () => HC.state;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MODE = { path: "路徑", move: "原運鏡", in: "推近", out: "拉遠", panR: "右移", panL: "左移", panU: "上移", panD: "下移", none: "靜止" };
  let sel = null, srcClip = null, analyzing = false;
  const selSet = new Set();   // 多選：被選取的鏡頭 id
  const targets = () => S().shots.filter((s) => selSet.has(s.id));
  const idxOf = (id) => S().shots.findIndex((x) => x.id === id);

  /* ---------- 小工具 ---------- */
  const toast = (msg, ms = 2600) => { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), ms); };
  let dlP = null;
  const downloads = () => dlP || (dlP = (window.claude && window.claude.use ? window.claude.use("downloads") : Promise.resolve(null)).catch(() => null));
  async function saveFile(name, data) {
    const d = await downloads();
    if (d) {
      try { await d.save({ filename: name, data }); toast("已儲存 " + name); return; }
      catch (e) { if (e && e.code === "declined") return toast("已取消儲存"); if (e && !["unavailable", "not_granted", "capability_disabled", "capability_removed"].includes(e.code)) return toast("無法儲存：" + (e.message || e.code)); }
    }
    const blob = data instanceof Blob ? data : new Blob([data], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  // 標題用 600、副標和鏡頭文字用 400／500，三種粗細都要先載好，匯出的第一格才不會是替代字型
  const fontsReady = () => Promise.all(["Noto Serif TC", "Noto Sans TC", "LXGW WenKai TC"].flatMap((f) => [400, 500, 600].map((w) => document.fonts.load(`${w} 40px "${f}"`, "FFXIV 庭園夜 " + [S().title.main, S().title.sub, S().title.info, S().ending.main].join("")).catch(() => {}))));

  /* ---------- 匯入素材 ---------- */
  /* handles：同順序的檔案捷徑（有的話記下來，下次可以直接找回檔案） */
  function addFiles(list, handles) {
    [...list].forEach((f, i) => handles && handles[i] && HC.fileHandles.put(f.name, handles[i]));
    const files = [...list].filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|m4v)$/i.test(f.name));
    if (!files.length) return toast("沒有可用的影片檔");
    let added = 0;
    for (const f of files) {
      let c = S().clips.find((x) => x.name === f.name);
      if (c && !c.missing) continue;
      if (!c) { c = { id: HC.uid("c"), name: f.name, excluded: [] }; S().clips.push(c); }
      c.missing = false; c.url = URL.createObjectURL(f); c.size = f.size; c.file = f;
      c.time = HC.fileTime(f.name, f.lastModified); c.status = "wait"; c.prog = 0; c.ana = null;
      added++;
    }
    HC.sortClips();
    renderBin();
    if (added) toast(`加入 ${added} 支素材，開始分析…`);
    runAnalysis();
  }
  async function runAnalysis() {
    if (analyzing) return;
    analyzing = true;
    // 同時分析兩支（解碼器通常可以兩路並行，整體快將近一倍）
    await Promise.all([analyzeWorker(), analyzeWorker()]);
    analyzing = false;
    afterAnalysis();
  }
  async function analyzeWorker() {
    for (;;) {
      const c = S().clips.find((x) => x.status === "wait");
      if (!c) break;
      c.status = "busy";
      renderBin();
      try {
        let lastDraw = 0;
        // 同一支素材（檔名＋大小相同）分析過就直接用之前的結果
        const hit = await HC.anaCache.get(c);
        if (hit && hit.v === HC.ANA_VER && hit.ana) { c.ana = hit.ana; c.dur = hit.dur; c.w = hit.w; c.h = hit.h; }
        else {
          await HC.analyzeClip(c, (p) => { c.prog = p; if (performance.now() - lastDraw > 250) { lastDraw = performance.now(); updateClipRow(c); } });
          HC.anaCache.put(c);
        }
        HC.segmentClip(c, S().auto);
        c.status = "done";
        HC.computeScenes();
      } catch (e) { c.status = "error"; }
      renderBin();
      if (srcClip === c) drawSrcGraph();
    }
  }
  function afterAnalysis() {
    const ready = S().clips.some((c) => c.ana);
    $("autoBtn").disabled = $("autoBtn2").disabled = !ready;
    if (ready && !S().shots.length) { runAuto(true); toast("分析完成，已自動剪好第一版"); }
    else if (ready) { toast("素材分析完成"); renderTimeline(); seek(R.T); }
    if (S().out.proxy) makeProxies();
  }

  /* ---------- 素材區 ---------- */
  function renderBin() {
    const cs = S().clips;
    const nScene = HC.computeScenes();
    $("binCount").textContent = cs.length ? `${cs.length} 支` + (nScene > 1 ? ` ・ ${nScene} 個場景` : "") : "";
    const WHY = { time: "拍攝時間相隔較久", look: "畫面換了", mark: "你手動分的" };
    const nMiss = cs.filter((c) => c.missing).length;
    // 白天／夜晚：點一下切換（自動 → 白天 → 夜晚）
    const todBtn = (scene) => { const t = HC.timeOfDay(scene); return `<button class="tod" data-tod="${scene}" title="${t.guess ? "自動判斷" : "你設定的"}：${HC.TOD_NAMES[t.tod]}（點一下切換）" aria-label="場景 ${scene + 1}：${HC.TOD_NAMES[t.tod]}">${t.tod === "night" ? "🌙" : "☀"}${t.guess ? "" : "・"}</button>`; };
    const typeSel = (scene) => {
      const st = HC.sceneType(scene);
      return `<select data-stype="${scene}" aria-label="場景 ${scene + 1} 的類型" title="標記場景類型：自動剪輯會分開學庭園、室內的剪法">${Object.entries(HC.SCENE_TYPES).map(([k, v]) => `<option value="${k}" ${k === (st.guess ? "" : st.type) ? "selected" : ""}>${k ? v : st.guess ? `猜是${HC.SCENE_TYPES[st.type]}` : "類型？"}</option>`).join("")}</select>`;
    };
    $("binList").innerHTML = (nMiss ? `<div class="relink"><span>還有 ${nMiss} 支素材沒有檔案</span><button class="btn" id="relinkBtn">找回素材檔</button></div>` : "") + cs.map((c, i) => (nScene > 1 && (!i || c.scene !== cs[i - 1].scene) ? `
      <div class="scene"><span>場景 ${c.scene + 1}${c.sceneWhy ? `<small>${WHY[c.sceneWhy]}</small>` : ""}</span>${todBtn(c.scene)}${typeSel(c.scene)}${i ? `<button data-join="${c.id}" title="把這個場景併回上一個場景">併回上一個</button>` : ""}</div>` : "") + `
      <div class="clip ${srcClip === c ? "on" : ""}" data-id="${c.id}" tabindex="0" role="button">${i && c.scene === cs[i - 1].scene ? `<button class="split" data-split="${c.id}" title="從這支素材開始新的場景" aria-label="從這支素材開始新的場景">分場景</button>` : ""}
        <img alt="" data-thumb="${c.id}">
        <div><div class="nm" title="${esc(c.name)}">${esc(label(c))}</div>
        <div class="meta" data-meta="${c.id}">${esc(meta(c))}</div>
        <div class="bar" data-bar="${c.id}">${bar(c)}</div></div>
      </div>`).join("");
    for (const c of cs) if (!c.missing && c.url) {
      const img = document.querySelector(`[data-thumb="${c.id}"]`);
      HC.thumb(c, 1.5).then((u) => { if (u && img) img.src = u; });
    }
    $("drop").querySelector("strong").textContent = cs.length ? "再加入素材" : "把錄好的素材拖進來";
  }
  /* 檔名有拍攝時間就顯示時間，比較好認 */
  function label(c) {
    const m = c.name.match(/(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})-(\d{2})-(\d{2})/);
    return m ? `${+m[2]}/${+m[3]} ${m[4]}:${m[5]}:${m[6]}` : c.name;
  }
  function meta(c) {
    if (c.missing) return "缺少檔案，請重新匯入同名檔案";
    const d = c.dur ? HC.fmt(c.dur) : "";
    if (c.status === "busy") return `分析中 ${Math.round((c.prog || 0) * 100)}%`;
    if (c.status === "wait") return "等待分析";
    if (c.status === "error") return "無法讀取這支影片";
    const nc = c.ana ? c.ana.cursor.length : 0, nu = c.ana && c.ana.ui ? c.ana.ui.length : 0;
    return d + (nc ? ` ・ 鼠標 ${nc} 處` : "") + (nu ? ` ・ 介面 ${nu} 處` : "");
  }
  function bar(c) {
    if (!c.cls || !c.dur) return "";
    const col = { S: "var(--still)", M: "var(--move)", F: "var(--fast)", X: "var(--fast)", C: "var(--cur)", U: "var(--ui)", E: "var(--ex)" };
    const { t, c: k } = c.cls;
    let html = "", start = 0;
    for (let i = 1; i <= t.length; i++) {
      if (i === t.length || k[i] !== k[start]) {
        const a = i === 1 ? 0 : t[start], b = i === t.length ? c.dur : t[i];
        html += `<i style="width:${((b - a) / c.dur * 100).toFixed(2)}%;background:${col[k[start]]}"></i>`;
        start = i;
      }
    }
    return html;
  }
  function updateClipRow(c) {
    const m = document.querySelector(`[data-meta="${c.id}"]`);
    if (m) m.textContent = meta(c);
  }

  /* ---------- 原始素材檢視 ---------- */
  function openSource(c, t) {
    if (!c || c.missing) return toast("這支素材還沒匯入");
    srcClip = c;
    $("shotForm").classList.add("hidden"); $("shotEmpty").classList.add("hidden"); $("srcPanel").classList.remove("hidden");
    showTab("shot");
    $("srcName").textContent = c.name;
    const v = $("srcVid");
    if (v.dataset.clip !== c.id) { v.src = c.url; v.dataset.clip = c.id; }
    if (t != null) { const go = () => { v.currentTime = t; }; v.readyState ? go() : v.addEventListener("loadedmetadata", go, { once: true }); }
    renderBin(); renderEx(); drawSrcGraph();
  }
  function drawSrcGraph() {
    const cv = $("srcGraph"), c = srcClip;
    if (!c) return;
    const W = cv.clientWidth || 260, H = 64;
    cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio;
    const g = cv.getContext("2d");
    g.scale(devicePixelRatio, devicePixelRatio);
    const css = getComputedStyle(document.documentElement), col = (n) => css.getPropertyValue(n).trim();
    g.fillStyle = col("--bg"); g.fillRect(0, 0, W, H);
    const D = c.dur || 1, x = (t) => t / D * W;
    if (c.cls) {
      const map = { S: col("--still"), M: col("--move"), F: col("--fast"), X: col("--fast"), C: col("--cur"), U: col("--ui"), E: col("--ex") };
      const { t, c: k } = c.cls;
      for (let i = 0; i < t.length; i++) { g.fillStyle = map[k[i]]; g.fillRect(x(i ? t[i - 1] : 0), 14, Math.max(1, x(t[i]) - x(i ? t[i - 1] : 0)) + 0.5, 22); }
      // 動態曲線
      g.strokeStyle = "rgba(255,255,255,.55)"; g.lineWidth = 1; g.beginPath();
      c.ana.t.forEach((tt, i) => { const y = 36 - Math.min(22, c.ana.m[i]); i ? g.lineTo(x(tt), y) : g.moveTo(x(tt), y); });
      g.stroke();
    }
    if (c.ana) { g.fillStyle = col("--cur"); for (const [a, b] of c.ana.cursor) g.fillRect(x(a), 40, Math.max(2, x(b) - x(a)), 8); }
    if (c.ana && c.ana.ui) { g.fillStyle = col("--ui"); for (const [a, b] of c.ana.ui) g.fillRect(x(a), 40, Math.max(2, x(b) - x(a)), 8); }
    g.fillStyle = col("--ex"); for (const [a, b] of c.excluded) g.fillRect(x(a), 50, Math.max(2, x(b) - x(a)), 8);
    g.fillStyle = "#fff";
    for (const s of S().shots) if (s.clipId === c.id) { g.fillRect(x(s.start), 2, Math.max(2, x(s.start + s.dur) - x(s.start)), 6); }
    const v = $("srcVid");
    g.fillStyle = col("--accent"); g.fillRect(x(v.currentTime || 0) - 1, 0, 2, H);
  }
  function renderEx() {
    const c = srcClip;
    $("srcEx").innerHTML = (c.excluded || []).map(([a, b], i) => `<li>排除 ${HC.fmt(a)} – ${HC.fmt(b)}<button data-ex="${i}" aria-label="移除這段排除">✕</button></li>`).join("");
  }
  let exA = null;

  /* ---------- 鏡頭設定 ---------- */
  /* how：省略 = 只選這個；"toggle" = Ctrl 點（加入／移出）；"range" = Shift 點（選一整段）；"keep" = 只重新整理表單 */
  function select(id, how) {
    if (how === "toggle" && id) { if (selSet.has(id)) selSet.delete(id); else selSet.add(id); id = selSet.has(id) ? id : [...selSet].pop() || null; }
    else if (how === "range" && id && sel && idxOf(sel) >= 0) {
      const a = idxOf(sel), b = idxOf(id); selSet.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selSet.add(S().shots[i].id);
    } else if (how === "keep") { for (const x of [...selSet]) if (idxOf(x) < 0) selSet.delete(x); if (id) selSet.add(id); }
    else { selSet.clear(); if (id) selSet.add(id); }
    sel = id && idxOf(id) >= 0 ? id : null;
    if (srcClip) { srcClip = null; renderBin(); }   // 只有在關掉素材檢視時才需要重畫素材區
    $("srcPanel").classList.add("hidden");
    const s = S().shots.find((x) => x.id === sel);
    $("shotEmpty").classList.toggle("hidden", !!s);
    $("shotForm").classList.toggle("hidden", !s);
    document.querySelectorAll(".shot").forEach((el) => el.classList.toggle("on", selSet.has(el.dataset.id)));
    if (!s) return;
    const many = selSet.size > 1;
    $("shotForm").classList.toggle("many", many);
    $("sMulti").classList.toggle("hidden", !many);
    $("sMulti").textContent = many ? `已選 ${selSet.size} 個鏡頭：下面的修改會套用到全部（表單顯示的是最後點的那一個）` : "";
    const c = HC.clip(s.clipId);
    $("sClip").textContent = (c ? c.name : "（缺少素材）") + `　原始 ${HC.fmt(s.start)} – ${HC.fmt(s.start + s.dur)}`;
    const setv = (id, val) => { if (document.activeElement !== $(id)) $(id).value = val; };
    setv("sStart", s.start); setv("sDur", s.dur); setv("sMode", s.mode);
    setv("sZoom", Math.round(s.zoom * 100)); $("sZoomV").textContent = Math.round(s.zoom * 100) + "%";
    $("sZoom").disabled = s.mode === "move" || s.mode === "path";
    $("sRampRow").classList.toggle("hidden", s.mode !== "move");
    setv("sRamp", s.ramp || ""); setv("sFreeze", s.freeze || 0);
    $("sPathRow").classList.toggle("hidden", s.mode !== "path");
    if (s.mode !== "path" && kfEdit) { kfEdit = null; document.querySelector(".stage").classList.remove("kfedit"); }
    const kf = s.kf || HC.defaultPath(s), q = kf[kfEdit || "a"];
    setv("sKfZ", Math.round(q.z * 100)); $("sKfZV").textContent = Math.round(q.z * 100) + "%";
    $("sKfA").setAttribute("aria-pressed", kfEdit === "a"); $("sKfB").setAttribute("aria-pressed", kfEdit === "b");
    for (const k of ["b", "c", "s", "t"]) { const v = Math.round(((s.adj && s.adj[k]) || 0) * 100), id = "sAdj" + k.toUpperCase(); setv(id, v); $(id + "V").textContent = (v > 0 ? "+" : "") + v; }
    $("sPasteFx").disabled = !fxClip;
    renderLabels(s);
    // 畫面合成：可以選時間軸上的其他鏡頭當另一邊／小視窗
    const opts = (cur) => `<option value="">不使用</option>` + S().shots.map((x, k) => x === s ? "" : `<option value="${x.id}" ${cur && cur.from === x.id ? "selected" : ""}>${k + 1}. ${esc((HC.clip(x.clipId) || {}).name || "")} ${HC.fmt(x.start)}</option>`).join("");
    if (document.activeElement !== $("sSplit")) $("sSplit").innerHTML = opts(s.split);
    if (document.activeElement !== $("sPip")) $("sPip").innerHTML = opts(s.pip);
    $("sPipOpt").classList.toggle("hidden", !s.pip);
    if (s.pip) { setv("sPipCorner", s.pip.corner || "br"); setv("sPipSize", Math.round((s.pip.size || 0.3) * 100)); $("sPipSizeV").textContent = Math.round((s.pip.size || 0.3) * 100) + "%"; }
    setv("sSpeed", String(s.speed)); setv("sText", s.text || "");
    const i = S().shots.indexOf(s);
    $("sTr").disabled = $("sTrDur").disabled = i === 0;
    setv("sTr", (s.tr && s.tr.type) || "cut"); setv("sTrDur", (s.tr && s.tr.dur) || HC.trInfo((s.tr && s.tr.type) || "cut").dur);
    setv("sFilter", s.filter || "");
    $("sStab").checked = !!s.stab; setv("sStabStr", Math.round((s.stabStr ?? 0.6) * 100)); $("sStabV").textContent = stabLabel(s);
    $("sStabRow").classList.toggle("hidden", !s.stab);
    $("sWhy").classList.toggle("hidden", many || !s.why || !s.why.length);
    $("sWhy").textContent = s.why && s.why.length ? "為什麼選這個：" + s.why.join("・") : "";
    $("sGood").setAttribute("aria-pressed", s.fb === 1); $("sBad").setAttribute("aria-pressed", s.fb === -1);
    $("sFocusRow").classList.toggle("hidden", (s.mode === "move" && !HC.vertical()) || s.mode === "path");
    $("sFocusV").textContent = s.fx != null ? `（你設定的：${Math.round(s.fx * 100)}%, ${Math.round(s.fy * 100)}%）` : s.afx != null ? "（自動：細節最多的地方）" : "（正中央）";
    showFocusDot();
  }
  /* 預覽畫面上標出目標點 */
  function showFocusDot() {
    let dot = document.querySelector(".focusdot");
    const s = cur();
    if (!s || !picking) { dot && dot.remove(); return; }
    if (!dot) { dot = document.createElement("div"); dot.className = "focusdot"; $("view").parentElement.appendChild(dot); }
    // 以目標點為中心縮放時，目標點在畫面上的位置剛好就是 (fx, fy)
    const [fx, fy] = HC.focusOf(s);
    dot.style.left = fx * 100 + "%"; dot.style.top = fy * 100 + "%";
  }
  let picking = false, kfEdit = null, fxClip = null, labelPick = false;
  /* 標註清單 */
  function renderLabels(s) {
    const L = s.labels || [];
    $("sLabN").textContent = L.length ? `（${L.length}）` : "";
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest("#sLabList")) return;   // 正在打字時不要重畫
    $("sLabList").innerHTML = L.map((lb, k) => `<div class="lab" data-k="${k}">
      <input data-f="text" value="${esc(lb.text)}" placeholder="名稱，例如：掛畫" aria-label="標註文字">
      <input data-f="sub" value="${esc(lb.sub || "")}" placeholder="細節（選填）" aria-label="標註細節">
      <select data-f="side" aria-label="文字框方向">${[["ne", "右上"], ["nw", "左上"], ["se", "右下"], ["sw", "左下"]].map(([v, n]) => `<option value="${v}" ${lb.side === v ? "selected" : ""}>${n}</option>`).join("")}</select>
      <button data-del="${k}" aria-label="刪除標註">✕</button></div>`).join("");
  }
  const cur = () => S().shots.find((x) => x.id === sel);
  const stabLabel = (s) => !s.stab ? "" : (HC.stabFailed(s) ? "（分析失敗，稍後播放會再試）" : HC.stabReady(s) ? "" : "（分析中…）") + Math.round((s.stabStr ?? 0.6) * 100) + "%";
  const stabDone = () => { renderTimeline(); const s = cur(); if (s) $("sStabV").textContent = stabLabel(s); refresh(); };
  let editing = false;
  function edit(fn, live) {
    const s = cur(); if (!s) return;
    if (!editing) { HC.commit(); editing = true; }
    const list = selSet.size > 1 ? targets() : [s];
    for (const x of list) {
      fn(x);
      const c = HC.clip(x.clipId);
      if (c && c.dur) { x.start = HC.clamp(x.start, 0, c.dur - 0.5); x.dur = HC.clamp(x.dur, 0.5, c.dur - x.start); }
      HC.noteEdit && HC.noteEdit(x);
    }
    if (!live) editing = false;
    renderTimeline(); select(s.id, "keep"); refresh();
    HC.stabQueue(stabDone);
  }

  /* ---------- 時間軸 ---------- */
  const pps = () => +$("tlZoom").value;
  function renderTimeline() {
    const { starts, total } = HC.timeline(), p = pps();
    const width = Math.max(total * p + 60, $("tlScroll").clientWidth - 28);
    $("tlTrack").style.width = width + "px";
    const step = p >= 30 ? 2 : p >= 14 ? 5 : p >= 7 ? 10 : 20;
    let r = "";
    for (let t = 0; t <= total + 0.01; t += step) r += `<span style="left:${t * p}px">${HC.fmt(t).replace(/\.0$/, "")}</span>`;
    $("ruler").innerHTML = r + (HC.beatTimes ? HC.beatTimes().map((b) => `<i class="beat" style="left:${b * p}px"></i>`).join("") : "");
    $("shots").innerHTML = S().shots.map((s, i) => {
      // 有轉場的地方，前後兩個鏡頭在轉場中點交接，方塊才會對齊上面的時間尺
      const x0 = (starts[i] + HC.trDur(i) / 2) * p, x1 = (starts[i] + HC.outDur(s) - HC.trDur(i + 1) / 2) * p;
      const w = Math.max(6, x1 - x0 - 2), c = HC.clip(s.clipId);
      const lab = `${MODE[s.mode]}${s.text ? "・" + s.text : ""} ${HC.outDur(s).toFixed(1)}s`;
      const fb = s.fb === 1 ? "👍" : s.fb === -1 ? "👎" : "";
      return `<div class="shot ${s.mode === "move" ? "mv" : "st"} ${selSet.has(s.id) ? "on" : ""}" style="left:${x0}px;width:${w}px" data-id="${s.id}" draggable="true" tabindex="0" title="${esc((c ? c.name : "缺少素材") + "  " + lab)}">
        <span class="h l" data-trim="l" title="拖曳修剪開頭"></span><span class="h r" data-trim="r" title="拖曳修剪結尾"></span>${fb ? `<span class="fbk">${fb}</span>` : ""}
        <span class="k"></span>${i && s.tr && s.tr.type !== "cut" ? `<span class="trk ${s.tr.type === "black" ? "black" : ""}" title="轉場：${HC.trInfo(s.tr.type).name}"></span>` : ""}${s.stab && w > 56 ? `<span class="stb">${HC.stabFailed(s) ? "防抖失敗" : HC.stabReady(s) ? "防抖" : "防抖…"}</span>` : ""}<span class="lb">${i + 1}. ${esc(lab)}</span></div>`;
    }).join("");
    for (const s of S().shots) {
      const c = HC.clip(s.clipId), el = document.querySelector(`.shot[data-id="${s.id}"]`);
      if (c && !c.missing && c.url) HC.thumb(c, s.start + s.dur / 2).then((u) => { if (u && el) el.style.backgroundImage = `url(${u})`; });
    }
    const n = S().shots.length;
    $("tlInfo").textContent = n ? `${n} 個鏡頭 ・ 共 ${HC.fmt(total)}` : "還沒有鏡頭";
    $("exportBtn").disabled = $("exportBtn2").disabled = $("hfBtn").disabled = $("thumbBtn").disabled = $("chapBtn").disabled = !n;
    presetHint();
    $("scrub").max = Math.max(1, Math.round(total * 10));
    renderBeatInfo();
    movePlayhead(R.T);
  }
  function movePlayhead(T) {
    $("playhead").style.left = T * pps() + "px";
    const { total } = HC.timeline();
    $("timeLbl").textContent = `${HC.fmt(T)} / ${HC.fmt(total)}`;
    $("scrub").value = Math.round(T * 10);
    const at = HC.shotAt(T);
    if (at) { const c = HC.clip(S().shots[at.i].clipId); $("shotLbl").textContent = `鏡頭 ${at.i + 1}／${S().shots.length}` + (c ? `・${c.name.replace(/^.*?(\d{2}-\d{2}-\d{2})\.\w+$/, "$1")}` : ""); }
    else $("shotLbl").textContent = "";
    if (R.isPlaying()) {
      const sc = $("tlScroll"), x = T * pps();
      if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 40;
    }
  }
  let refreshT;
  const refresh = () => { clearTimeout(refreshT); refreshT = setTimeout(() => { if (!R.isPlaying()) seek(Math.min(R.T, HC.timeline().total)); }, 60); };
  const seek = (T) => R.seek(T);

  /* ---------- 自動剪輯 ---------- */
  function runAuto(silent) {
    if (!S().clips.some((c) => c.ana)) return;
    if (S().shots.length) HC.commit();
    R.stop();
    HC.autoEdit();
    afterNewTimeline();
    if (!silent) toast(`自動剪輯完成：${S().shots.length} 個鏡頭，${HC.fmt(HC.timeline().total)}` + (HC.lastDedupe ? `（去掉 ${HC.lastDedupe} 個重複角度）` : ""));
  }
  function afterNewTimeline() {
    bestSection();
    syncForms(); renderBin(); renderTimeline(); renderLearn(); renderRec();
    HC.stabQueue(stabDone);
    select(S().shots[0] ? S().shots[0].id : null);
    R.T = 0; seek(0);
  }
  /* 推薦的音樂和環境音（依畫面） */
  async function renderRec() {
    if (!S().shots.length) return;
    await HC.loadLibrary();
    const r = HC.recommendAudio();
    $("recText").textContent = `推薦：音樂 ${r.music.map(HC.libCatName).join("、")}；環境音 ${r.amb.map(HC.libCatName).join("、") || "—"}（${r.why.join("；")}）`;
    $("recBtn").disabled = false;
  }
  /* 自動挑音樂最好聽的一段 */
  function bestSection(say) {
    const M = S().music;
    if (M.autoSec === false || !M.url || !HC.beatInfo || !HC.beatInfo() || !S().shots.length) return;
    const b = HC.bestMusicOffset(HC.timeline().total);
    M.off = b.off; if (b.endOnBar) M.fade = Math.min(M.fade, 2.5);
    $("mOff").value = b.off; $("mFade") && ($("mFade").value = M.fade);
    renderTimeline();
    if (say) toast(`音樂從 ${HC.fmt(b.off)} 開始${b.endOnBar ? "，結尾剛好在樂句結束" : ""}`);
  }
  /* ---------- 做 3 個版本讓你挑 ---------- */
  let variantsOrig = null;
  function showVariants() {
    if (!S().clips.some((c) => c.ana)) return toast("先匯入並分析素材");
    R.stop();
    variantsOrig = variantsOrig || S().shots;
    const vs = HC.makeVariants(), box = $("variants");
    const len = (shots) => { const o = S().shots; S().shots = shots; const t = HC.timeline().total; S().shots = o; return t; };
    box.innerHTML = vs.map((v, k) => `<div class="vcard" data-k="${k}"><h4>${esc(v.name)}</h4><p>${esc(v.desc)}・${v.shots.length} 個鏡頭・${HC.fmt(len(v.shots))}</p><div class="vstrip">${[0, 1, 2, 3, 4].map(() => "<i></i>").join("")}</div><div class="btnrow"><button class="btn" data-prev="${k}">在時間軸預覽</button><button class="btn accent" data-pick="${k}">用這個</button></div></div>`).join("") + `<button class="btn" id="varCancel">取消，回到原本的</button>`;
    box.classList.remove("hidden");
    vs.forEach((v, k) => {
      const strip = box.querySelectorAll(".vcard")[k].querySelectorAll("i");
      [0, 1, 2, 3, 4].forEach((j) => { const s = v.shots[Math.floor(j * (v.shots.length - 1) / 4)], c = s && HC.clip(s.clipId); if (c && c.url) HC.thumb(c, s.start + s.dur / 2).then((u) => { if (u) strip[j].style.backgroundImage = `url(${u})`; }); });
    });
    box.onclick = (e) => {
      const t = e.target.closest("button"); if (!t) return;
      if (t.id === "varCancel") { S().shots = variantsOrig; variantsOrig = null; box.classList.add("hidden"); afterNewTimeline(); return; }
      const v = vs[+(t.dataset.prev ?? t.dataset.pick)];
      box.querySelectorAll(".vcard").forEach((el) => el.classList.toggle("on", el.dataset.k === (t.dataset.prev ?? t.dataset.pick)));
      if (t.dataset.prev != null) { S().shots = v.shots; afterNewTimeline(); toast(`預覽「${v.name}」，按「用這個」確定`); return; }
      const orig = variantsOrig; S().shots = orig; HC.commit();
      S().shots = v.shots; HC.markAuto && HC.markAuto();
      HC.learnFromChoice(v, vs);
      variantsOrig = null; box.classList.add("hidden");
      afterNewTimeline();
      toast(`已使用「${v.name}」，也記住你喜歡這種風格`, 4000);
    };
  }
  /* ---------- 短影音版 ---------- */
  async function makeShortVersion() {
    if (!S().shots.length) return toast("先剪好完整版");
    await saveVersion(`完整版（${HC.fmt(HC.timeline().total)}）`);
    HC.commit();
    S().shots = HC.makeShort(S().shots, 45);
    S().out.aspect = "9:16"; $("oAspect").value = "9:16"; applyAspect();
    if (!S().music.lib || S().music.autoSec !== false) bestSection();
    afterNewTimeline();
    toast("已做成直式 45 秒短影音版；完整版存在「版本」裡", 4500);
  }
  /* ---------- 版本 ---------- */
  async function saveVersion(name) {
    const list = await HC.autosave.versions();
    list.push({ id: HC.uid("v"), name, at: Date.now(), json: projectJSON() });
    await HC.autosave.saveVersions(list);
  }
  async function showVersions() {
    const ov = $("overlay"), list = await HC.autosave.versions();
    const when = (t) => new Date(t).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    ov.innerHTML = `<strong>版本</strong><p class="muted" style="margin:0">把目前的剪輯存起來，之後可以回到這個版本或比較看看（存在這個瀏覽器裡）。</p>
      <div class="btnrow"><input id="verName" type="text" placeholder="版本名稱，例如：給朋友看的版本" style="flex:1"><button class="btn accent" id="verSave">存成新版本</button></div>
      <div class="verlist">${list.length ? list.slice().reverse().map((v) => `<div class="ver"><div>${esc(v.name)}<small>${when(v.at)}・${(() => { try { const o = JSON.parse(v.json); return o.shots.length + " 個鏡頭"; } catch (e) { return ""; } })()}</small></div><button class="btn" data-open="${v.id}">開啟</button><button class="btn" data-del="${v.id}" aria-label="刪除 ${esc(v.name)}">刪除</button></div>`).join("") : `<p class="muted">還沒有存過版本</p>`}</div>
      <button class="btn" id="verClose">關閉</button>`;
    ov.classList.remove("hidden");
    ov.onclick = async (e) => {
      const t = e.target.closest("button"); if (!t) return;
      if (t.id === "verClose") { ov.classList.add("hidden"); ov.onclick = null; return; }
      if (t.id === "verSave") { await saveVersion($("verName").value.trim() || `版本（${when(Date.now())}）`); toast("已存成新版本"); showVersions(); return; }
      if (t.dataset.del) { await HC.autosave.saveVersions(list.filter((v) => v.id !== t.dataset.del)); showVersions(); return; }
      if (t.dataset.open) {
        const v = list.find((x) => x.id === t.dataset.open);
        await saveVersion(`開啟「${v.name}」之前的自動備份`);
        HC.commit(); loadProject(JSON.parse(v.json), true); syncForms(); applyAspect(); afterNewTimeline();
        ov.classList.add("hidden"); ov.onclick = null; toast(`已回到「${v.name}」（原本的存成自動備份）`);
      }
    };
  }

  /* ---------- 找回素材檔：用之前記住的檔案捷徑（第一次會問你允不允許讀取） ---------- */
  async function relink() {
    const miss = S().clips.filter((c) => c.missing);
    const files = [];
    for (const c of miss) { const f = await HC.fileHandles.file(c.name); if (f) files.push(f); }
    if (files.length) addFiles(files);
    const left = miss.length - files.length;
    toast(left ? `找回 ${files.length} 支，還有 ${left} 支請重新匯入（同檔名會自動對上）` : `已找回 ${files.length} 支素材`, 4000);
  }
  /* 打開網頁時：有上次自動存的專案就問要不要繼續 */
  async function offerResume() {
    const saved = await HC.autosave.load();
    if (!saved || !saved.json || S().clips.length) return;
    let o; try { o = JSON.parse(saved.json); } catch (e) { return; }
    if (!o.shots || !o.shots.length) return;
    const bar = document.createElement("div");
    bar.className = "resume";
    const when = new Date(saved.at).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    bar.innerHTML = `<span><strong>繼續上次的專案？</strong>「${esc(o.name || "未命名")}」${o.shots.length} 個鏡頭・${when} 自動儲存</span><button class="btn accent" id="resumeYes">繼續</button><button class="btn" id="resumeNo">開新專案</button>`;
    $("binList").before(bar);
    $("resumeYes").onclick = async () => {
      bar.remove(); loadProject(o, true);
      const m = await HC.autosave.music();
      if (m && m.lib) { const f = await HC.libMusicFile(m.lib); if (f) setMusic(f, true, m.lib); }
      else if (m && m.blob) setMusic(new File([m.blob], m.name || "music"), true);
      await HC.restoreAmb(o.amb);
      if (S().clips.some((c) => c.missing)) relink();
    };
    $("resumeNo").onclick = () => { bar.remove(); HC.autosave.clear(); };
  }

  /* ---------- 專案存檔 ---------- */
  function projectJSON() {
    const s = S();
    return JSON.stringify({
      app: "housing-cut", version: 1, name: $("projName").value,
      clips: s.clips.map((c) => ({ id: c.id, name: c.name, time: c.time, dur: c.dur, excluded: c.excluded, sceneMark: c.sceneMark || "", stype: c.stype || "", tod: c.tod || "" })),
      shots: s.shots, title: s.title, ending: s.ending, look: s.look, out: s.out, auto: s.auto, wm: { ...s.wm, _img: undefined },
      music: { name: s.music.name, vol: s.music.vol, off: s.music.off, fade: s.music.fade, lib: s.music.lib || "" },
      amb: HC.ambForSave(),
    }, null, 2);
  }
  function loadProject(o, fromAutosave) {
    if (!o || o.app !== "housing-cut") return toast("這不是本工具的專案檔");
    R.stop();
    const s = S();
    $("projName").value = o.name || "";
    const keep = new Map(s.clips.map((c) => [c.name, c]));
    s.clips = o.clips.map((c) => {
      const have = keep.get(c.name);
      if (have) { have.excluded = c.excluded || []; have.sceneMark = c.sceneMark || ""; have.stype = c.stype || ""; have.tod = c.tod || ""; const old = have.id; for (const sh of o.shots) if (sh.clipId === c.id) sh.clipId = old; return have; }
      return { id: c.id, name: c.name, time: c.time, dur: c.dur, excluded: c.excluded || [], sceneMark: c.sceneMark || "", stype: c.stype || "", tod: c.tod || "", missing: true };
    });
    s.shots = o.shots.map(HC.migrateShot); Object.assign(s.title, o.title); Object.assign(s.out, o.out); Object.assign(s.auto, o.auto);
    if (o.title && o.title.show === false) s.title.template = "none";
    if (o.ending) Object.assign(s.ending, o.ending);
    if (o.wm) Object.assign(s.wm, o.wm);
    if (o.look) { s.look.filter = o.look.filter || "none"; s.look.filterStr = o.look.filterStr ?? 1; s.look.tintStr = o.look.tintStr ?? 1; Object.assign(s.look.fx, o.look.fx || {}); }
    if (s.title.pos === "center") s.title.pos = "auto";   // 舊版的「畫面中央」= 現在的「跟模板一樣」
    Object.assign(s.music, { vol: o.music.vol, off: o.music.off, fade: o.music.fade });
    // 開舊專案：音樂庫的音樂和音效直接從庫裡拿回來；自己的音樂檔要重新選
    if (!fromAutosave) {
      if (o.music.lib) HC.libMusicFile(o.music.lib).then((f) => f && setMusic(f, true, o.music.lib));
      HC.restoreAmb((o.amb || []).filter((a) => a.lib));
    }
    syncForms(); renderBin(); renderTimeline(); select(null);
    const miss = s.clips.filter((c) => c.missing).length;
    toast(miss ? `專案已開啟，請再匯入 ${miss} 支素材（同檔名會自動對上）` : "專案已開啟", 4000);
    seek(0);
  }

  /* ---------- 設定表單 ---------- */
  function syncWm() {
    const w = S().wm;
    $("wOn").checked = !!w.on; $("wText").value = w.text || ""; $("wCorner").value = w.corner || "br";
    $("wSize").value = Math.round((w.size || 0.1) * 100); $("wSizeV").textContent = $("wSize").value + "%";
    $("wOp").value = Math.round((w.opacity ?? 0.75) * 100); $("wOpV").textContent = $("wOp").value + "%";
    $("wKindText").setAttribute("aria-pressed", w.kind !== "image"); $("wKindImg").setAttribute("aria-pressed", w.kind === "image");
    $("wTextRow").classList.toggle("hidden", w.kind === "image"); $("wImgRow").classList.toggle("hidden", w.kind !== "image");
    $("wImgName").textContent = w.img ? "已選擇圖片" : "";
  }
  function syncForms() {
    syncWm();
    const s = S();
    $("tMain").value = s.title.main; $("tSub").value = s.title.sub; $("tInfo").value = s.title.info || ""; $("tFont").value = s.title.font;
    $("tSize").value = s.title.size; $("tColor").value = s.title.color; $("tAccent").value = s.title.accent || "#e9c46a"; $("tPos").value = s.title.pos; $("tLine").checked = s.title.line; $("tDur").value = s.title.dur;
    $("eTpl").value = s.ending.template; $("eMain").value = s.ending.main; $("eSub").value = s.ending.sub || ""; $("eDur").value = s.ending.dur;
    $("aOrder").value = s.auto.order; $("aTrMode").value = s.auto.trMode; $("aTrType").value = s.auto.trType; $("aTrTypeRow").classList.toggle("hidden", s.auto.trMode !== "all");
    renderTiles();
    $("aLen").value = s.auto.len; $("aRhy").value = Math.round(s.auto.rhythm * 100); $("aSpeed").value = String(s.auto.speed); $("aZoom").value = Math.round(s.auto.zoom * 100);
    $("aTol").value = Math.round(s.auto.tol * 100); $("aHead").value = s.auto.head; $("aCursor").checked = s.auto.cursor;
    $("aSceneLook").value = Math.round((s.auto.sceneLook ?? 0.5) * 100);
    $("aUI").checked = s.auto.ui; $("aStab").checked = s.auto.stab; $("aStabStr").value = Math.round(s.auto.stabStr * 100); $("aLearn").checked = s.auto.learn; $("aCover").checked = s.auto.cover; $("aLateral").checked = s.auto.lateral; $("aBeat").checked = s.auto.beat !== false; $("aGap").value = s.auto.gap;
    $("aFitMusic").checked = s.auto.fitMusic !== false; $("aDedupe").checked = s.auto.dedupe !== false; $("aDayNight").checked = s.auto.dayNight !== false; $("mBest").checked = s.music.autoSec !== false;
    $("mVol").value = Math.round(s.music.vol * 100); $("mOff").value = s.music.off; $("mFade").value = s.music.fade;
    $("oAspect").value = s.out.aspect || "16:9"; applyAspect();
    $("oPreset").value = s.out.preset || ""; $("oProxy").checked = !!s.out.proxy;
    $("oMode").value = s.out.mode || "frames"; $("oFps").value = String(s.out.fps || 30);
    $("oRes").value = String(s.out.res); $("oRate").value = String(s.out.rate); $("oFi").value = s.out.fi; $("oFo").value = s.out.fo;
    outputs();
  }
  function outputs() {
    const s = S();
    $("aLenV").textContent = HC.fmt(s.auto.len).replace(/\.0$/, "");
    $("aRhyV").textContent = s.auto.rhythm < 0.25 ? "平穩，多長鏡頭" : s.auto.rhythm < 0.6 ? "長短交錯" : "明快，多短鏡頭";
    $("aZoomV").textContent = Math.round(s.auto.zoom * 100) + "%";
    $("aTolV").textContent = s.auto.tol < 0.34 ? "嚴格" : s.auto.tol < 0.67 ? "一般" : "寬鬆";
    $("aStabV").textContent = Math.round(s.auto.stabStr * 100) + "%";
    $("aSceneV").textContent = sceneLabel(s.auto.sceneLook ?? 0.5);
    $("mVolV").textContent = Math.round(s.music.vol * 100) + "%";
    const m = R.pickMime(), frames = exportMode() === "frames";
    $("oFmt").textContent = frames ? "逐格輸出會優先用 MP4（H.264），電腦不支援時改用 WebM。" : m ? `這個瀏覽器會輸出 ${m.includes("mp4") ? "MP4" : "WebM"} 檔。` : "這個瀏覽器不支援錄製影片，請改用電腦版 Chrome 或 Edge。";
    $("oModeHint").textContent = frames ? "一格一格畫好再存，畫面不會掉格；時間依電腦速度而定，通常是影片長度的 1～4 倍。可以切到其他分頁，但會變慢。"
      : (HC.canFrameExport() ? "" : "這個瀏覽器不支援逐格輸出，只能即時錄製。") + "即時錄製：2 分鐘的影片要錄 2 分鐘，錄製時請讓這個分頁保持在最前面。";
    $("oFps").disabled = !frames;
  }
  const sceneLabel = (v) => (v <= 0 ? "關閉（只看拍攝時間）" : v < 0.35 ? "低" : v < 0.7 ? "中" : "高");
  const bindVal = (id, fn, ev = "input") => $(id).addEventListener(ev, (e) => { fn(e.target); outputs(); refresh(); });

  function showTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => { b.classList.toggle("on", b.dataset.tab === name); b.setAttribute("aria-selected", b.dataset.tab === name); });
    document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("on", p.id === "pane-" + name));
  }

  /* ---------- 學習分頁 ---------- */
  const dist = (m) => {
    const e = Object.entries(m || {}).filter(([, v]) => v > 0.001), t = e.reduce((a, [, v]) => a + v, 0);
    return t ? e.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${HC.trInfo(k).name} ${Math.round(v / t * 100)}%`).join("、") : "—";
  };
  const topName = (m, name) => { const t = HC.topOf(m); return t ? `${name(t[0])}（${t[1]} 次）` : "—"; };
  function renderLearn() {
    const P = HC.profile, st = P.style;
    const modeName = { in: "推近", out: "拉遠", panR: "右移", panL: "左移", panU: "上移", panD: "下移" };
    const tot = Object.values(st.modes).reduce((a, b) => a + b, 0) || 1;
    const top = Object.entries(st.modes).sort((a, b) => b[1] - a[1]).filter(([, v]) => v / tot > 0.08).map(([k, v]) => `${modeName[k]} ${Math.round(v / tot * 100)}%`).join("、");
    const ex = P.examples.length, good = P.examples.filter((e) => e.y).length;
    $("lSummary").innerHTML = [
      ["長鏡頭", st.longStill.toFixed(1) + " 秒"], ["短鏡頭", st.shortStill.toFixed(1) + " 秒"],
      ["短鏡頭比例", Math.round(st.rhythm * 100) + "%"], ["縮放幅度", Math.round(st.zoom * 100) + "%"],
      ["運鏡佔比", Math.round(st.moveRatio * 100) + "%"], ["運鏡速度", st.moveSpeed.toFixed(2) + "×"],
      ["影片長度", st.len ? HC.fmt(st.len).replace(/\.\d$/, "") : "—"], ["每支素材", st.perClip ? `約 ${st.perClip.toFixed(1)} 個鏡頭` : "—"],
      ["鏡頭順序", st.order.n ? (st.order.chrono >= 0.7 ? `照拍攝順序（${Math.round(st.order.chrono * 100)}%）` : `會重排（照順序 ${Math.round(st.order.chrono * 100)}%）`) : "—"],
      ["接法", st.order.n ? `靜止後接運鏡 ${Math.round((st.order.seq.SM || 0) * 100)}%・開場用${st.order.firstS >= 0.5 ? "靜止" : "運鏡"}` : "—"],
      ["換素材轉場", dist(st.tr.change)], ["換場景轉場", dist(st.tr.gap)],
      ["運鏡頭尾", P.fine && P.fine.n ? `開頭裁 ${P.fine.trimHead.toFixed(1)} 秒、結尾裁 ${P.fine.trimTail.toFixed(1)} 秒` : "—"],
      ["效果怎麼選", P.modeW ? `看畫面內容（已學 ${P.modeEx.length} 個例子）` : `照規則（細節集中→推近）${P.modeEx.length ? `・再 ${Math.max(0, 10 - P.modeEx.length)} 個例子就會改用你的習慣` : ""}`],
      ["分場景類型學", Object.entries(P.byType).filter(([, b]) => b.n).map(([t, b]) => `${HC.SCENE_TYPES[t]}（${b.n} 次，長鏡頭 ${(b.longStill || st.longStill).toFixed(1)} 秒）`).join("、") || "—（在素材區把場景標成庭園／室內就會分開學）"],
      ["常用開頭", topName(P.look.opening, (k) => HC.titleTpl(k).name)], ["常用濾鏡", topName(P.look.filter, (k) => HC.filterInfo(k).name)],
      ["推近平移比例", top || "—"],
    ].map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join("") +
      `<span class="src">學習來源：手動修改 ${P.edits} 次 ・ 參考影片 ${P.refs.length} 支 ・ 鏡頭範例 ${ex} 個（好 ${good}／壞 ${ex - good}）${P.w ? " ・ 挑片段模型已啟用" : ex ? " ・ 範例再多一點就會啟用挑片段模型" : ""}</span>`;
    const names = HC.profiles.names();
    $("lProf").innerHTML = names.map((n) => `<option ${n === HC.profiles.active() ? "selected" : ""}>${esc(n)}</option>`).join("");
    $("lDel").disabled = names.length < 2; $("lUndo").disabled = !HC.profiles.canUndo();
    $("lRefs").innerHTML = P.refs.map((r, i) => `<li><span>${esc(r.name)}<span class="sub">${r.shots} 個鏡頭 ・ 平均 ${r.avg.toFixed(1)} 秒 ・ 黑場 ${Math.round(r.dips * 100)}% ・ 疊化 ${Math.round((r.fades || 0) * 100)}%</span></span><button data-ref="${i}" aria-label="移除這支參考影片的紀錄">✕</button></li>`).join("");
  }

  /* ---------- 轉場、開頭、濾鏡的選擇格子 ---------- */
  let trSel = "fade";
  function fillSelects() {
    const opts = (arr) => arr.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
    $("sTr").innerHTML = opts(HC.TRANSITIONS);
    $("aTrType").innerHTML = opts(HC.TRANSITIONS.filter((t) => t.id !== "cut"));
    $("sFilter").innerHTML = `<option value="">跟整支影片一樣</option>` + opts(HC.FILTERS);
    $("eTpl").innerHTML = opts(HC.TITLE_TEMPLATES.filter((t) => t.id !== "typewriter").map((t) => (t.id === "none" ? { ...t, name: "不要片尾" } : t)));
  }
  let lookThumb = "", lookCanvas = null;
  function renderTiles() {
    $("trTiles").innerHTML = HC.TRANSITIONS.map((t) => `<button class="tile ${t.id === trSel ? "on" : ""}" data-tr="${t.id}" aria-pressed="${t.id === trSel}"><span class="pv ${t.id}"><span class="a"></span><span class="b"></span><span class="ov"></span></span>${esc(t.name)}</button>`).join("");
    $("trDurV").textContent = (+$("trDur").value).toFixed(1) + " 秒";
    const ti = S().title, cur = ti.template;
    const cls = (t) => (t.layout === "lowleft" ? "left low" : t.layout === "left" ? "left" : t.layout === "cinema" ? "low" : "");
    $("tTiles").innerHTML = HC.TITLE_TEMPLATES.map((t) => `<button class="tile ${t.id === cur ? "on" : ""}" data-tpl="${t.id}" aria-pressed="${t.id === cur}"><span class="pv"><span class="tt ${cls(t)}">${t.id === "none" ? "" : "FFXIV<i>HOUSING</i>"}</span></span>${esc(t.name)}</button>`).join("");
    const f = S().look.filter;
    $("fTiles").innerHTML = HC.FILTERS.map((x) => `<button class="tile ${x.id === f ? "on" : ""}" data-filter="${x.id}" aria-pressed="${x.id === f}"><span class="pv">${lookThumb ? `<img alt="" src="${lookThumb}" style="filter:${HC.filterCss(x.id, S().look.filterStr ?? 1) || "none"}">` : `<span class="a" style="filter:${HC.filterCss(x.id, S().look.filterStr ?? 1) || "none"}"></span>`}${x.tint ? `<span class="ov" style="opacity:1;background:${HC.tintFill(x.id, S().look.tintStr ?? 1)};mix-blend-mode:soft-light"></span>` : ""}</span>${esc(x.name)}</button>`).join("");
    $("fHint").textContent = HC.canFilter ? "" : "這個瀏覽器不支援畫布濾鏡，只會套用色調。建議用 Chrome 或 Edge。";
    const L = S().look;
    $("fStr").value = Math.round((L.filterStr ?? 1) * 100); $("fTint").value = Math.round((L.tintStr ?? 1) * 100);
    $("fStrV").textContent = $("fStr").value + "%"; $("fTintV").textContent = $("fTint").value + "%";
    $("fTintRow").classList.toggle("hidden", !HC.filterInfo(L.filter).tint);
    renderFx();
  }
  /* ---------- 特效縮圖 ---------- */
  let fxSel = "vignette", fxAnim = null;
  function renderFx() {
    const fx = S().look.fx;
    $("fxTiles").innerHTML = HC.EFFECTS.map((e) => `<button class="tile ${fx[e.id] ? "on" : ""} ${e.id === fxSel ? "sel" : ""}" data-fxid="${e.id}" aria-pressed="${!!fx[e.id]}"><span class="pv"><canvas width="320" height="180" data-fxc="${e.id}"></canvas>${fx[e.id] ? `<span class="badge">${Math.round(fx[e.id] * 100)}%</span>` : ""}</span>${esc(e.name)}</button>`).join("");
    for (const e of HC.EFFECTS) drawFxThumb(e.id, 2.5);
    const v = fx[fxSel] || 0;
    $("fxStr").value = Math.round((v || 0.6) * 100);
    $("fxStrV").textContent = `${HC.EFFECTS.find((e) => e.id === fxSel).name} ${v ? Math.round(v * 100) + "%" : "（關閉中）"}`;
  }
  // 縮圖：目前畫面 + 這個特效（關閉中的也顯示 60% 的樣子，讓你先看效果）
  function drawFxThumb(id, T) {
    const c = document.querySelector(`[data-fxc="${id}"]`);
    if (!c) return;
    const g = c.getContext("2d"), W = c.width, H = c.height;
    if (lookCanvas) g.drawImage(lookCanvas, 0, 0, W, H);
    else { const gr = g.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, "#f2b07a"); gr.addColorStop(0.45, "#f2b07a"); gr.addColorStop(0.45, "#4f6f52"); gr.addColorStop(1, "#3a5240"); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
    HC.drawEffects(g, W, H, T, { [id]: S().look.fx[id] || 0.6 }, c, 3);
  }
  function animateFx(id) {
    cancelAnimationFrame(fxAnim);
    if (!id || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t0 = performance.now();
    const step = () => { drawFxThumb(id, 2.5 + (performance.now() - t0) / 1000); fxAnim = requestAnimationFrame(step); };
    fxAnim = requestAnimationFrame(step);
  }
  function snapLook() {   // 用目前預覽畫面當濾鏡縮圖
    try {
      const c = document.createElement("canvas"); c.width = 320; c.height = 180;
      const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage($("view"), 0, 0, 320, 180);
      // 預覽還沒畫好（全黑）時用示意圖，不要讓縮圖全部變黑
      const d = g.getImageData(0, 0, 320, 180).data; let sum = 0; for (let i = 0; i < d.length; i += 64) sum += d[i] + d[i + 1] + d[i + 2];
      if (!S().shots.length || sum / (d.length / 64) < 12) { lookThumb = ""; lookCanvas = null; return; }
      lookThumb = c.toDataURL("image/jpeg", 0.75); lookCanvas = c;
    } catch (e) { lookThumb = ""; lookCanvas = null; }
  }
  const seekEnd = () => { if (S().shots.length && !R.isPlaying()) { const { total } = HC.timeline(); seek(Math.max(0, total - (S().out.fo || 0) - 1)); } };
  function applyTr(targets) {
    if (!targets.length) return toast("先在時間軸選一個鏡頭");
    HC.commit();
    const d = +$("trDur").value;
    for (const s of targets) s.tr = { type: trSel, dur: trSel === "cut" ? 0 : d };
    renderTimeline(); refresh();
    toast(`已套用「${HC.trInfo(trSel).name}」到 ${targets.length} 個接點`);
  }
  /* 學到的開頭、片尾、濾鏡：開新專案時預先選好 */
  function applyLearnedLook() {
    const L = HC.profile && HC.profile.look;
    if (!L) return;
    const o = HC.topOf(L.opening), f = HC.topOf(L.filter), e = HC.topOf(L.ending);
    if (o) S().title.template = o[0];
    if (f) S().look.filter = f[0];
    if (e) S().ending.template = e[0];
  }

  /* ---------- 匯出 ---------- */
  async function doExport() {
    if (!S().shots.length) return;
    const miss = S().clips.filter((c) => c.missing && S().shots.some((s) => s.clipId === c.id));
    if (miss.length) return toast("還缺素材：" + miss.map((c) => c.name).join("、"), 5000);
    const frames = exportMode() === "frames";
    if (!frames && !R.pickMime()) return toast("這個瀏覽器不支援錄製影片，請改用電腦版 Chrome 或 Edge", 5000);
    await fontsReady();
    const ov = $("overlay");
    if (S().shots.some((s) => s.stab && !HC.stabReady(s))) {
      ov.innerHTML = `<strong>防抖分析中…</strong><div class="pbar"><i id="pb"></i></div>`;
      ov.classList.remove("hidden");
      await HC.stabWaitAll((p) => { $("pb").style.width = (p * 100).toFixed(0) + "%"; });
      renderTimeline();
    }
    ov.innerHTML = `<strong>${frames ? "逐格輸出中…" : "匯出中…"}</strong><div class="pbar"><i id="pb"></i></div><span id="pt" class="muted">0%</span><span class="muted">${frames ? "可以切到其他分頁，但會變慢" : "請讓這個分頁保持在最前面"}</span><button class="btn" id="cancelEx">取消</button>`;
    ov.classList.remove("hidden");
    let cancelled = false;
    $("cancelEx").onclick = () => { cancelled = true; R.cancelExport && R.cancelExport(); };
    const prog = (p, eta) => { $("pb").style.width = (p * 100).toFixed(1) + "%"; $("pt").textContent = Math.round(p * 100) + "%" + (eta > 3 && p > 0.02 ? `・還要約 ${eta >= 90 ? Math.round(eta / 60) + " 分鐘" : Math.round(eta) + " 秒"}` : ""); };
    try {
      const { blob, ext } = frames ? await R.exportFrames(prog, () => cancelled) : await R.exportVideo(prog);
      ov.classList.add("hidden");
      if (cancelled) return toast("已取消匯出");
      if (S().auto.learn && HC.lastAuto) { const r = HC.learnFromEdits(); if (r.ok) { renderLearn(); setTimeout(() => toast("已從這次的修改學習剪輯風格"), 3000); } }
      const name = ($("projName").value || "housing").replace(/[\\/:*?"<>|]/g, "_") + "." + ext;
      const mb = (blob.size / 1048576).toFixed(1);
      ov.innerHTML = `<strong>匯出完成（${mb} MB）</strong><button class="btn accent" id="dlEx">下載 ${esc(name)}</button><button class="btn" id="closeEx">關閉</button>`;
      ov.classList.remove("hidden");
      $("dlEx").onclick = () => saveFile(name, blob);
      $("closeEx").onclick = () => { ov.classList.add("hidden"); seek(0); };
    } catch (e) {
      ov.classList.add("hidden");
      if (e && e.cancelled) return toast("已取消匯出");
      toast("匯出失敗：" + e.message, 5000);
    }
  }
  function renderBeatInfo() {
    const b = HC.beatInfo && HC.beatInfo();
    $("mBeat").textContent = !S().music.url ? "" : b ? `偵測到約 ${Math.round(b.bpm)} BPM，共 ${b.beats.length} 拍（時間尺上的小橘點）。拖鏡頭邊緣時會吸附到拍點。` : "正在找拍點…";
    $("mSnap").disabled = !b || !S().shots.length;
  }
  /* 畫面比例：預覽畫布跟著變成直式／橫式 */
  function applyAspect() {
    const v = HC.vertical(), cv = $("view"), sz = HC.outSize(1080), sc = document.querySelector(".screen");
    if (cv.width !== sz.W || cv.height !== sz.H) { cv.width = sz.W; cv.height = sz.H; }
    sc.classList.toggle("vertical", v); sc.style.setProperty("--ar", `${sz.W}/${sz.H}`);
    $("oAspectHint").textContent = v ? "非橫式會從素材裡裁出一塊：每個鏡頭依「推近的目標點」決定保留哪一塊（自動找細節最多的地方，也可以在鏡頭設定裡自己點）。" : "";
  }
  /* ---------- 平台預設 ---------- */
  const PRESETS = {
    yt: { aspect: "16:9", res: 1080, rate: 16, fps: 30, name: "YouTube 1080p" },
    yt4k: { aspect: "16:9", res: 2160, rate: 40, fps: 30, name: "YouTube 4K" },
    shorts: { aspect: "9:16", res: 1080, rate: 16, fps: 30, max: 60, name: "Shorts／Reels／TikTok" },
    igsq: { aspect: "1:1", res: 1080, rate: 10, fps: 30, max: 90, name: "Instagram 方形" },
    ig45: { aspect: "4:5", res: 1080, rate: 10, fps: 30, max: 90, name: "Instagram 4:5" },
  };
  function presetHint() {
    const p = PRESETS[S().out.preset], t = HC.timeline().total;
    $("oPresetHint").textContent = !p ? "" : p.max && t > p.max ? `目前影片 ${HC.fmt(t)}，${p.name}建議 ${p.max} 秒內：可以到「自動剪輯」分頁按「產生短影音版」。` : `已設定：${HC.outSize().W}×${HC.outSize().H}、${p.fps} fps、約 ${p.rate} Mbps。`;
  }
  function applyPreset(id) {
    const p = PRESETS[id]; S().out.preset = id; if (!p) return presetHint();
    Object.assign(S().out, { aspect: p.aspect, res: p.res, rate: p.rate, fps: p.fps });
    $("oAspect").value = p.aspect; $("oRes").value = String(p.res); $("oRate").value = String(p.rate); $("oFps").value = String(p.fps);
    applyAspect(); select(sel, "keep"); refresh(); presetHint();
  }
  /* ---------- 封面圖：挑 3 個好看的畫面，加上大標題 ---------- */
  async function makeThumbs() {
    const sh = S().shots; if (!sh.length) return;
    R.stop();
    const score = (s) => (s.fb === 1 ? 2 : s.fb === -1 ? -2 : 0) + (s.mode === "move" ? 0 : 0.4) + (HC.predict(HC.features(s.clipId, s.start, s.start + s.dur, s.mode === "move")) ?? 0.5) + (s.labels ? 0.2 : 0);
    const picks = sh.map((s, i) => ({ s, i, sc: score(s) })).sort((a, b) => b.sc - a.sc);
    const chosen = []; for (const p of picks) { if (chosen.every((c) => c.s.clipId !== p.s.clipId)) chosen.push(p); if (chosen.length === 3) break; }
    const box = $("thumbs"); box.innerHTML = ""; box.classList.remove("hidden");
    const { starts } = HC.timeline(), T0 = R.T;
    R.noOverlay = true;
    try {
      for (const [k, p] of chosen.entries()) {
        await R.seek(starts[p.i] + HC.outDur(p.s) * 0.55);
        const c = document.createElement("canvas"); c.width = 1280; c.height = 720;
        const g = c.getContext("2d"), v = $("view"), sc = Math.max(1280 / v.width, 720 / v.height), sw = 1280 / sc, shh = 720 / sc;
        g.drawImage(v, (v.width - sw) / 2, (v.height - shh) / 2, sw, shh, 0, 0, 1280, 720);
        drawThumbText(g, k);
        const wrap = document.createElement("div"); wrap.className = "tc";
        const btn = document.createElement("button"); btn.className = "btn"; btn.textContent = `下載封面 ${k + 1}（1280×720 JPG）`;
        btn.onclick = () => c.toBlob((b) => saveFile(`${(S().title.main || "cover").replace(/[\\/:*?"<>|]/g, "")}-封面${k + 1}.jpg`, b), "image/jpeg", 0.92);
        wrap.append(c, btn); box.appendChild(wrap);
      }
    } finally { R.noOverlay = false; seek(T0); }
  }
  function drawThumbText(g, k) {
    const T = S().title, main = T.main || "FFXIV HOUSING", sub = T.sub || "";
    const grad = g.createLinearGradient(0, 300, 0, 720); grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,.75)");
    g.fillStyle = grad; g.fillRect(0, 300, 1280, 420);
    let fs = 112; g.font = `800 ${fs}px "${T.font}", "Noto Sans TC", sans-serif`;
    while (g.measureText(main).width > 1160 && fs > 48) { fs -= 4; g.font = `800 ${fs}px "${T.font}", "Noto Sans TC", sans-serif`; }
    const x = k === 1 ? 640 : 60, al = k === 1 ? "center" : "left";
    g.textAlign = al; g.lineJoin = "round";
    g.lineWidth = fs * 0.12; g.strokeStyle = "rgba(0,0,0,.85)"; g.strokeText(main, x, sub ? 590 : 640);
    g.fillStyle = "#fff"; g.fillText(main, x, sub ? 590 : 640);
    if (sub) { g.font = `600 44px "Noto Sans TC", sans-serif`; g.lineWidth = 6; g.strokeText(sub, x, 665); g.fillStyle = T.accent || "#f5d58a"; g.fillText(sub, x, 665); }
  }
  /* ---------- YouTube 章節：依場景分段 ---------- */
  function makeChapters() {
    const sh = S().shots, { starts } = HC.timeline(), groups = [];
    sh.forEach((s, i) => {
      const c = HC.clip(s.clipId), sc = c ? c.scene || 0 : 0, last = groups[groups.length - 1];
      if (!last || last.scene !== sc) groups.push({ scene: sc, t: starts[i], s }); 
    });
    // YouTube 規定每段至少 10 秒，太短的併到前一段
    const out = [];
    for (const g of groups) { if (out.length && g.t - out[out.length - 1].t < 10) continue; out.push(g); }
    if (out.length) out[0].t = 0;
    const name = (g) => {
      const type = HC.sceneType(g.scene).type, tod = HC.timeOfDay(g.scene).tod;
      const base = g.s.text || (type ? HC.SCENE_TYPES[type] : `場景 ${g.scene + 1}`);
      return base + (tod === "night" ? "（夜晚）" : "");
    };
    const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    const lines = out.map((g, k) => `${fmt(g.t)} ${k === 0 && !g.s.text ? "開場・" : ""}${name(g)}`);
    const note = out.length < 3 ? "\n\n（YouTube 至少要 3 段、每段 10 秒以上才會顯示章節；可以在素材區把場景分細一點）" : "";
    showText("YouTube 章節（貼到影片說明裡，名稱可以直接改）", lines.join("\n") + note, true);
  }
  // 播放中換了音樂或環境音效：馬上換成新的聲音
  function restartAudio() { if (R.isPlaying()) R.music.start(R.T); }
  /* 顯示一段可以複製的文字（例如音樂來源清單） */
  function showText(title, text, editable) {
    const ov = $("overlay");
    ov.innerHTML = `<strong>${esc(title)}</strong><textarea id="stText" ${editable ? "" : "readonly"} rows="12" style="width:min(640px,90vw);font:13px/1.7 inherit">${esc(text)}</textarea><div class="btnrow"><button class="btn" id="stCopy">複製</button><button class="btn" id="stClose">關閉</button></div>`;
    ov.classList.remove("hidden");
    $("stCopy").onclick = () => navigator.clipboard.writeText($("stText").value).then(() => toast("已複製"), () => toast("請手動選取文字複製"));
    $("stClose").onclick = () => ov.classList.add("hidden");
  }
  /* ---------- 第一次使用的導覽 ---------- */
  const TOUR = [
    ["label[for=fileIn]", "1. 匯入素材", "把遊戲錄的影片拖進來或按這裡。分析完會自動剪好第一版；有鼠標、遊戲介面的畫面會自動避開。"],
    ["#autoBtn", "2. 自動剪輯", "隨時可以重新自動剪輯。「自動剪輯」分頁還能「做 3 個版本讓我挑」、產生短影音版。"],
    [".tl", "3. 時間軸", "點鏡頭看設定；拖邊緣修剪長度、按 S 分割、Ctrl／Shift 多選。拖鏡頭可以換順序。"],
    [".side", "4. 右邊的分頁", "鏡頭效果、轉場、開頭片尾、濾鏡、音樂庫（免費音樂和環境音）、學習、匯出都在這裡。"],
    ["#libMusicBtn", "5. 音樂和環境音", "內建 100 多首免費音樂、音效，也會依畫面推薦。", "music"],
    ["#exportBtn", "6. 匯出", "預設逐格輸出，不會掉格。「匯出」分頁有 YouTube、Shorts、IG 的預設，還能產生封面圖和章節。"],
  ];
  function tour(k = 0) {
    document.querySelector(".tour") && document.querySelector(".tour").remove();
    if (k >= TOUR.length) { try { localStorage.setItem("housingcut.tour", "1"); } catch (e) {} return; }
    const [selr, title, text, tab] = TOUR[k];
    if (tab) document.querySelector(`[data-tab="${tab}"]`) && document.querySelector(`[data-tab="${tab}"]`).click();
    const el = document.querySelector(selr); if (!el || !el.getClientRects().length) return tour(k + 1);
    el.scrollIntoView({ block: "nearest" });
    const r = el.getBoundingClientRect(), wrap = document.createElement("div");
    wrap.className = "tour";
    wrap.innerHTML = `<div class="hole" style="left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px"></div>
      <div class="card" role="dialog" aria-label="${esc(title)}"><h4>${esc(title)}</h4><p>${esc(text)}</p><div class="btnrow"><button class="btn" data-t="skip">略過</button><span>${k > 0 ? `<button class="btn" data-t="prev">上一步</button> ` : ""}<button class="btn accent" data-t="next">${k === TOUR.length - 1 ? "開始使用" : "下一步"}</button></span></div></div>`;
    document.body.appendChild(wrap);
    const card = wrap.querySelector(".card"), cw = card.offsetWidth, ch = card.offsetHeight;
    let top = r.bottom + 14; if (top + ch > innerHeight - 8) top = Math.max(8, r.top - ch - 14);
    card.style.top = top + "px"; card.style.left = Math.max(12, Math.min(innerWidth - cw - 12, r.left)) + "px";
    card.querySelector('[data-t="next"]').focus();
    card.onclick = (e) => { const t = e.target.closest("[data-t]"); if (!t) return; tour(t.dataset.t === "next" ? k + 1 : t.dataset.t === "prev" ? k - 1 : TOUR.length); };
    card.onkeydown = (e) => { if (e.key === "Escape") tour(TOUR.length); };
  }

  /* 流暢預覽：依序替每支素材做代理檔 */
  let proxyBusy = false;
  async function makeProxies() {
    if (proxyBusy) return; proxyBusy = true;
    try {
      const todo = S().clips.filter((c) => c.file && !c.proxyUrl && !c.missing);
      let k = 0, made = 0;
      for (const c of todo) {
        if (!S().out.proxy) break;
        k++;
        const ok = await HC.makeProxy(c, (p) => { $("oProxyHint").textContent = `正在做預覽檔 ${k}／${todo.length}：${Math.round(p * 100)}%`; }).catch(() => false);
        if (ok) made++;
      }
      const all = S().clips.filter((c) => c.proxyUrl).length;
      $("oProxyHint").textContent = S().out.proxy ? `已有 ${all}／${S().clips.length} 支素材的預覽檔${all < S().clips.length ? "（非 MP4／H.264 的素材沒辦法做，會用原檔）" : ""}` : "";
      if (made) seek(R.T);
    } finally { proxyBusy = false; }
  }
  function setMusic(f, quiet, libId) {
    if (S().music.url) URL.revokeObjectURL(S().music.url);
    S().music.url = URL.createObjectURL(f); S().music.name = f.name; S().music.file = f; S().music.lib = libId || "";
    $("musicName").textContent = (libId ? "音樂庫：" : "") + f.name.replace(/\.[^.]+$/, "");
    HC.autosave.saveMusic(f, libId);
    restartAudio();
    renderBeatInfo();
    HC.analyzeBeats(f).then(() => { bestSection(); renderTimeline(); renderBeatInfo(); });
    if (!quiet) toast("已加入音樂，按播放試聽");
  }
  // 逐格輸出是預設；瀏覽器不支援時自動改用即時錄製
  const exportMode = () => (S().out.mode !== "realtime" && HC.canFrameExport() ? "frames" : "realtime");

  /* ---------- 事件 ---------- */
  function bind() {
    R.init($("view"));
    R.onTime = movePlayhead;
    R.onState = (p) => { $("playBtn").textContent = p ? "❚❚" : "▶"; $("playBtn").setAttribute("aria-label", p ? "暫停" : "播放"); };
    R.onError = () => toast("有鏡頭的素材還沒匯入，無法播放");

    $("fileIn").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
    // Chrome／Edge：改用檔案選擇器，順便記住檔案位置（下次打開專案可以直接找回素材）
    document.querySelectorAll('label[for="fileIn"]').forEach((l) => l.addEventListener("click", async (e) => {
      if (!HC.canPickFiles()) return;
      e.preventDefault();
      try {
        const hs = await window.showOpenFilePicker({ multiple: true, id: "clips", types: [{ description: "影片", accept: { "video/*": [".mp4", ".mov", ".webm", ".mkv", ".m4v"] } }] });
        addFiles(await Promise.all(hs.map((h) => h.getFile())), hs);
      } catch (err) { if (err && err.name !== "AbortError") $("fileIn").click(); }
    }));
    document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
    document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
    document.addEventListener("drop", (e) => {
      document.body.classList.remove("dragging");
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      // 拖進來的檔案也試著拿捷徑（要在事件當下先要，之後就拿不到了）
      const hp = [...e.dataTransfer.items].filter((it) => it.kind === "file").map((it) => (it.getAsFileSystemHandle ? it.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
      Promise.all(hp).then((hs) => addFiles(files, hs.length === files.length ? hs : null));
    });

    $("autoBtn").onclick = () => runAuto(); $("autoBtn2").onclick = () => runAuto();
    // 復原也可能改到標題、片尾、濾鏡，所以表單一起更新
    const afterHistory = () => { syncForms(); renderTimeline(); select(cur() ? sel : null); refresh(); };
    $("undoBtn").onclick = () => { if (HC.undo()) afterHistory(); };
    $("redoBtn").onclick = () => { if (HC.redo()) afterHistory(); };
    $("saveBtn").onclick = () => saveFile(($("projName").value || "housing") + ".json", projectJSON());
    $("projIn").addEventListener("change", async (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; try { loadProject(JSON.parse(await f.text())); } catch (err) { toast("專案檔讀取失敗"); } });
    $("exportBtn").onclick = doExport; $("exportBtn2").onclick = doExport;

    $("playBtn").onclick = () => { if (R.exporting) return; if (R.isPlaying()) R.stop(); else { HC.stabQueue(stabDone); const { total } = HC.timeline(); R.play(R.T >= total - 0.05 ? 0 : R.T); } };
    $("scrub").addEventListener("input", (e) => { const T = e.target.value / 10; movePlayhead(T); seek(T); });

    document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => showTab(b.dataset.tab));

    $("binList").addEventListener("click", (e) => {
      if (e.target.closest("#relinkBtn")) { relink(); return; }
      const td = e.target.closest("[data-tod]");
      if (td) {
        const sc = +td.dataset.tod, cs = S().clips.filter((c) => c.scene === sc), curT = (cs.find((c) => c.tod) || {}).tod || "";
        const next = { "": "day", day: "night", night: "" }[curT];
        HC.commit(); HC.setTimeOfDay(sc, next); renderBin();
        toast(next ? `場景 ${sc + 1} 設成${HC.TOD_NAMES[next]}` : `場景 ${sc + 1} 改回自動判斷（${HC.TOD_NAMES[HC.timeOfDay(sc).tod]}）`);
        return;
      }
      const sp = e.target.closest("[data-split],[data-join]");
      if (sp) {   // 手動分場景／併回：只影響之後的自動剪輯
        HC.commit();
        const c = HC.clip(sp.dataset.split || sp.dataset.join);
        c.sceneMark = sp.dataset.split ? "start" : "join";
        renderBin(); toast("場景已調整，按「自動剪輯」套用到時間軸");
        return;
      }
      const el = e.target.closest(".clip"); if (el) openSource(HC.clip(el.dataset.id));
    });
    $("binList").addEventListener("change", (e) => {
      const t = e.target.closest("[data-stype]"); if (!t) return;
      HC.commit(); HC.setSceneType(+t.dataset.stype, t.value); renderBin(); renderLearn();
      toast(t.value ? `已標成「${HC.SCENE_TYPES[t.value]}」，之後會分開學這類場景的剪法` : "已取消類型");
    });
    $("binList").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.target.closest("button")) { const el = e.target.closest(".clip"); if (el) openSource(HC.clip(el.dataset.id)); } });

    // 原始素材
    const v = $("srcVid");
    v.addEventListener("timeupdate", drawSrcGraph);
    v.addEventListener("seeked", drawSrcGraph);
    $("srcGraph").addEventListener("click", (e) => { if (!srcClip) return; const r = e.currentTarget.getBoundingClientRect(); v.currentTime = (e.clientX - r.left) / r.width * (srcClip.dur || 0); });
    $("srcAdd").onclick = () => {
      if (!srcClip) return;
      HC.commit();
      const len = Math.max(1, +$("srcLen").value || 5), mode = $("srcMode").value;
      const start = HC.clamp(v.currentTime, 0, Math.max(0, (srcClip.dur || len) - len));
      const s = { id: HC.uid("s"), clipId: srcClip.id, start: +start.toFixed(2), dur: +Math.min(len, (srcClip.dur || len) - start).toFixed(2), mode, zoom: mode === "move" ? 0 : S().auto.zoom, speed: mode === "move" ? S().auto.speed : 1, tr: { type: "cut", dur: 0 }, text: "", stab: mode === "move" && S().auto.stab, stabStr: S().auto.stabStr };
      const at = sel ? S().shots.findIndex((x) => x.id === sel) : -1;
      S().shots.splice(at >= 0 ? at + 1 : S().shots.length, 0, s);
      renderTimeline(); drawSrcGraph(); toast(`已加入第 ${S().shots.indexOf(s) + 1} 個鏡頭`);
    };
    $("srcExA").onclick = () => { exA = v.currentTime; toast(`排除起點 ${HC.fmt(exA)}，再按「排除：到這裡」`); };
    $("srcExB").onclick = () => {
      if (exA == null || !srcClip) return toast("先按「排除：從這裡」");
      HC.commit();
      const a = Math.min(exA, v.currentTime), b = Math.max(exA, v.currentTime);
      srcClip.excluded.push([+a.toFixed(2), +Math.max(b, a + 0.2).toFixed(2)]); exA = null;
      HC.segmentClip(srcClip, S().auto); renderEx(); renderBin(); drawSrcGraph();
    };
    $("srcEx").addEventListener("click", (e) => { const b = e.target.closest("[data-ex]"); if (!b) return; HC.commit(); srcClip.excluded.splice(+b.dataset.ex, 1); HC.segmentClip(srcClip, S().auto); renderEx(); renderBin(); drawSrcGraph(); });

    // 鏡頭設定
    $("sStart").addEventListener("change", (e) => edit((s) => s.start = +e.target.value || 0));
    $("sDur").addEventListener("change", (e) => edit((s) => s.dur = +e.target.value || 1));
    $("sMode").addEventListener("change", (e) => edit((s) => { s.mode = e.target.value; if (s.mode !== "move" && !s.zoom) s.zoom = S().auto.zoom; if (s.mode === "path" && !s.kf) s.kf = HC.defaultPath(s); }));
    $("sRamp").addEventListener("change", (e) => edit((s) => { if (e.target.value) s.ramp = e.target.value; else delete s.ramp; }));
    $("sFreeze").addEventListener("change", (e) => edit((s) => { const v = HC.clamp(+e.target.value || 0, 0, 5); if (v) s.freeze = v; else delete s.freeze; }));
    // 調色：拖的時候即時看，放開才算一次修改
    document.querySelectorAll("[data-adj]").forEach((el) => {
      el.addEventListener("input", () => edit((s) => { s.adj = { ...(s.adj || {}), [el.dataset.adj]: el.value / 100 }; }, true));
      el.addEventListener("change", () => { editing = false; });
    });
    $("sAdjReset").onclick = () => edit((s) => { delete s.adj; });
    $("autoColorBtn").onclick = async () => {
      if (!S().shots.length) return;
      $("autoColorBtn").disabled = true; toast("正在分析每個鏡頭的顏色…");
      try { HC.commit(); const n = await HC.autoColor(S().shots); renderTimeline(); select(sel, "keep"); refresh(); toast(`已調整 ${n} 個鏡頭的顏色（白天、夜晚分開對齊）`); }
      catch (e) { toast("自動配色失敗：" + e.message); }
      $("autoColorBtn").disabled = false;
    };
    /* 自訂路徑：選起點／終點後在預覽上拖曳、滾輪縮放 */
    const kfOf = (s) => (s.kf = s.kf || HC.defaultPath(s));
    function setKf(which) {
      kfEdit = which;
      document.querySelector(".stage").classList.toggle("kfedit", !!which);
      const s = cur();
      if (which && s) { const { starts } = HC.timeline(), i = S().shots.indexOf(s); seek(starts[i] + (which === "a" ? 0.02 : HC.outDur(s) - 0.05)); }
      if (s) select(s.id, "keep");
    }
    $("sKfA").onclick = () => setKf(kfEdit === "a" ? null : "a");
    $("sKfB").onclick = () => setKf(kfEdit === "b" ? null : "b");
    $("sKfReset").onclick = () => edit((s) => { s.kf = HC.defaultPath(s); });
    $("sKfZ").addEventListener("input", (e) => { edit((s) => { kfOf(s)[kfEdit || "a"].z = e.target.value / 100; }, true); kfPreview(); });
    $("sKfZ").addEventListener("change", () => { editing = false; });
    let kfDrag = null, kfRaf = 0;
    const kfPreview = () => { if (kfRaf) return; kfRaf = requestAnimationFrame(() => { kfRaf = 0; R.seek(R.T); }); };
    $("view").addEventListener("pointerdown", (e) => {
      if (!kfEdit || !cur()) return;
      e.preventDefault(); HC.commit();
      kfDrag = { x: e.clientX, y: e.clientY, q: { ...kfOf(cur())[kfEdit] } };
      $("view").setPointerCapture(e.pointerId);
    });
    $("view").addEventListener("pointermove", (e) => {
      if (!kfDrag) return;
      const r = $("view").getBoundingClientRect(), q = kfDrag.q, z = Math.max(1.001, q.z);
      // 拖曳畫面：往右拖 = 看左邊一點
      const s = cur(), k = kfOf(s)[kfEdit];
      k.x = HC.clamp(q.x - (e.clientX - kfDrag.x) / r.width / (z - 1), 0, 1);
      k.y = HC.clamp(q.y - (e.clientY - kfDrag.y) / r.height / (z - 1), 0, 1);
      kfPreview();
    });
    $("view").addEventListener("pointerup", () => { if (kfDrag) { kfDrag = null; select(sel, "keep"); renderTimeline(); } });
    $("view").addEventListener("wheel", (e) => {
      if (!kfEdit || !cur()) return;
      e.preventDefault();
      const k = kfOf(cur())[kfEdit];
      k.z = HC.clamp(k.z - e.deltaY * 0.0008, 1, 2);
      select(sel, "keep"); kfPreview();
    }, { passive: false });
    /* 複製效果 → 貼到選取的鏡頭 */
    const FX_KEYS = ["mode", "zoom", "speed", "ramp", "freeze", "filter", "adj", "stab", "stabStr", "kf", "fx", "fy"];
    const copyFx = () => { const s = cur(); if (!s) return; fxClip = { move: s.mode === "move", v: JSON.parse(JSON.stringify(Object.fromEntries(FX_KEYS.map((k) => [k, s[k]])))) }; $("sPasteFx").disabled = false; toast("已複製這個鏡頭的效果，選其他鏡頭後按「貼上效果」"); };
    const pasteFx = () => {
      if (!fxClip || !targets().length) return;
      edit((s) => {
        for (const k of FX_KEYS) {
          // 運鏡鏡頭和靜止畫面互貼時，不改效果種類和速度相關的設定
          if ((s.mode === "move") !== fxClip.move && ["mode", "speed", "ramp", "freeze", "zoom", "kf"].includes(k)) continue;
          if (fxClip.v[k] === undefined) delete s[k]; else s[k] = JSON.parse(JSON.stringify(fxClip.v[k]));
        }
      });
      toast(`已貼到 ${targets().length} 個鏡頭`);
    };
    $("sCopyFx").onclick = copyFx; $("sPasteFx").onclick = pasteFx;
    $("sZoom").addEventListener("input", (e) => edit((s) => s.zoom = e.target.value / 100, true));
    $("sZoom").addEventListener("change", () => { editing = false; });
    $("sSpeed").addEventListener("change", (e) => edit((s) => s.speed = +e.target.value));
    $("sTr").addEventListener("change", (e) => edit((s) => { s.tr = { type: e.target.value, dur: HC.trInfo(e.target.value).dur }; }));
    $("sTrDur").addEventListener("change", (e) => edit((s) => { s.tr = { type: (s.tr && s.tr.type) || "fade", dur: HC.clamp(+e.target.value || 0.8, 0.1, 3) }; }));
    $("sFilter").addEventListener("change", (e) => edit((s) => { if (e.target.value) s.filter = e.target.value; else delete s.filter; }));
    $("sStab").addEventListener("change", (e) => edit((s) => { s.stab = e.target.checked; if (s.stabStr == null) s.stabStr = S().auto.stabStr; }));
    $("sStabStr").addEventListener("input", (e) => edit((s) => s.stabStr = e.target.value / 100, true));
    $("sStabStr").addEventListener("change", () => { editing = false; });
    $("sText").addEventListener("input", (e) => edit((s) => s.text = e.target.value, true));
    $("sText").addEventListener("change", () => { editing = false; });
    $("sHere").onclick = () => { const s = cur(); if (!s) return; const at = HC.shotAt(R.T); if (at && S().shots[at.i] === s) edit((x) => { const o = at.off * x.speed; x.start += o; x.dur -= o; }); else toast("播放位置不在這個鏡頭裡"); };
    $("sSrc").onclick = () => { const s = cur(); if (s) openSource(HC.clip(s.clipId), s.start); };
    const moveShot = (d) => { const a = S().shots, i = a.findIndex((x) => x.id === sel); const j = i + d; if (i < 0 || j < 0 || j >= a.length) return; HC.commit(); [a[i], a[j]] = [a[j], a[i]]; renderTimeline(); refresh(); };
    $("sLeft").onclick = () => moveShot(-1); $("sRight").onclick = () => moveShot(1);
    const dup = () => { const a = S().shots, i = a.findIndex((x) => x.id === sel); if (i < 0) return; HC.commit(); const c = { ...JSON.parse(JSON.stringify(a[i])), id: HC.uid("s") }; a.splice(i + 1, 0, c); renderTimeline(); select(c.id); refresh(); };
    $("sDup").onclick = dup;
    const del = () => {
      const a = S().shots, list = targets(); if (!list.length) return;
      HC.commit();
      const i = Math.min(...list.map((x) => a.indexOf(x)));
      for (const x of list) { HC.noteDelete && HC.noteDelete(x); a.splice(a.indexOf(x), 1); }
      renderTimeline(); select(a[Math.min(i, a.length - 1)] ? a[Math.min(i, a.length - 1)].id : null); refresh();
      if (list.length > 1) toast(`已刪除 ${list.length} 個鏡頭`);
    };
    $("sDel").onclick = del;
    /* 在播放位置分割：把一個鏡頭切成兩個 */
    const split = () => {
      const at = HC.shotAt(R.T); if (!at) return toast("先把播放位置移到要分割的鏡頭上");
      const a = S().shots, s = a[at.i], o = at.off * s.speed;
      if (o < 0.3 || s.dur - o < 0.3) return toast("太靠近鏡頭的頭尾，沒辦法分割");
      HC.commit();
      const b = { ...JSON.parse(JSON.stringify(s)), id: HC.uid("s"), start: +(s.start + o).toFixed(2), dur: +(s.dur - o).toFixed(2), tr: { type: "cut", dur: 0 } };
      s.dur = +o.toFixed(2);
      a.splice(at.i + 1, 0, b);
      HC.noteEdit && HC.noteEdit(s); HC.noteEdit && HC.noteEdit(b);
      renderTimeline(); select(b.id); refresh(); HC.stabQueue(stabDone);
    };
    $("sSplit").onclick = split;
    // 目標點：按「在預覽畫面上點一下」，再點畫面
    $("sFocusPick").onclick = () => { picking = !picking; $("sFocusPick").setAttribute("aria-pressed", picking); document.querySelector(".stage").classList.toggle("picking", picking); if (picking) toast("在預覽畫面上點你想推近的地方"); showFocusDot(); };
    $("view").addEventListener("click", (e) => {
      if (labelPick) { addLabelAt(e); return; }
      if (!picking) return;
      const r = $("view").getBoundingClientRect(), u = (e.clientX - r.left) / r.width, w = (e.clientY - r.top) / r.height;
      const v = $("view"), sc = Math.max(v.width / 1920, v.height / 1080), sw = 1920 * (v.width / 1920) / sc, sh = 1080 * (v.height / 1080) / sc;
      edit((s) => {
        const [ox, oy] = HC.focusOf(s);
        // 點到的那個東西在素材裡的位置 → 新的目標點
        s.fx = +HC.clamp(((1920 - sw) * ox + u * sw) / 1920, 0.05, 0.95).toFixed(3);
        s.fy = +HC.clamp(((1080 - sh) * oy + w * sh) / 1080, 0.05, 0.95).toFixed(3);
      });
      picking = false; $("sFocusPick").setAttribute("aria-pressed", false); document.querySelector(".stage").classList.remove("picking");
      showFocusDot(); toast("已設定目標點");
    });
    // 標註
    const pickLabel = (on) => { labelPick = on; $("sLabAdd").setAttribute("aria-pressed", on); document.querySelector(".stage").classList.toggle("picking", on); };
    $("sLabAdd").onclick = () => {
      const s = cur(); if (!s) return;
      if (labelPick) return pickLabel(false);
      const i = S().shots.indexOf(s), at = HC.shotAt(R.T), { starts } = HC.timeline();
      if (!at || at.i !== i) seek(starts[i] + HC.outDur(s) / 2);   // 先跳到這個鏡頭
      pickLabel(true); toast("在預覽畫面上點要標註的位置");
    };
    function addLabelAt(e) {
      const s = cur(); pickLabel(false); if (!s) return;
      const i = S().shots.indexOf(s), { starts } = HC.timeline(), c = HC.clip(s.clipId), cv = $("view");
      const r = cv.getBoundingClientRect(), u = (e.clientX - r.left) / r.width, w = (e.clientY - r.top) / r.height;
      const vw = (c && c.w) || 1920, vh = (c && c.h) || 1080;
      const cr = HC.cropAt(s, HC.clamp(R.T - starts[i], 0, HC.outDur(s)), vw, vh, cv.width, cv.height);
      HC.commit();
      s.labels = s.labels || [];
      s.labels.push({ x: +((cr.sx + u * cr.sw) / vw).toFixed(4), y: +((cr.sy + w * cr.sh) / vh).toFixed(4), text: "", side: (u < 0.65 ? "e" : "w") === "e" ? (w > 0.35 ? "ne" : "se") : (w > 0.35 ? "nw" : "sw") });
      renderLabels(s); refresh();
      const ins = $("sLabList").querySelectorAll('input[data-f="text"]'); ins[ins.length - 1] && ins[ins.length - 1].focus();
    }
    $("sLabList").addEventListener("input", (e) => {
      const row = e.target.closest(".lab"), s = cur(); if (!row || !s) return;
      const lb = s.labels[+row.dataset.k]; if (!lb) return;
      if (!editing) { HC.commit(); editing = true; }
      lb[e.target.dataset.f] = e.target.value; refresh();
    });
    $("sLabList").addEventListener("change", () => { editing = false; });
    $("sLabList").addEventListener("click", (e) => {
      const d = e.target.closest("[data-del]"), s = cur(); if (!d || !s) return;
      HC.commit(); s.labels.splice(+d.dataset.del, 1); if (!s.labels.length) delete s.labels;
      renderLabels(s); refresh();
    });
    // 日夜對比、子母畫面
    const refOf = (id) => { const x = S().shots.find((y) => y.id === id); return x ? { from: x.id, clipId: x.clipId, start: x.start } : null; };
    $("sSplit").addEventListener("change", (e) => edit((s) => {
      const r = refOf(e.target.value);
      if (!r) { delete s.split; return; }
      const x = S().shots.find((y) => y.id === r.from);
      s.split = { ...r, labels: [HC.TOD_NAMES[HC.shotTod(s)] || "前", HC.TOD_NAMES[HC.shotTod(x)] || "後"] };
      if (s.split.labels[0] === s.split.labels[1]) s.split.labels = ["", ""];
    }));
    $("sPip").addEventListener("change", (e) => edit((s) => { const r = refOf(e.target.value); if (r) s.pip = { ...r, corner: (s.pip && s.pip.corner) || "br", size: (s.pip && s.pip.size) || 0.3 }; else delete s.pip; }));
    $("sPipCorner").addEventListener("change", (e) => edit((s) => { if (s.pip) s.pip.corner = e.target.value; }));
    $("sPipSize").addEventListener("input", (e) => edit((s) => { if (s.pip) s.pip.size = e.target.value / 100; }, true));
    $("sPipSize").addEventListener("change", () => { editing = false; });
    $("dnAuto").onclick = () => {
      const pair = HC.findDayNightPair(S().shots);
      if (!pair) return toast("找不到角度相近的白天、夜晚鏡頭（可以在素材區把場景標成白天／夜晚，或在上面自己選）");
      const [a, b] = pair; HC.commit();
      const n = { ...JSON.parse(JSON.stringify(a)), id: HC.uid("s"), mode: "none", zoom: 0.04, dur: Math.min(a.dur, 6), tr: { type: "fade", dur: 0.8 }, split: { from: b.id, clipId: b.clipId, start: b.start, labels: ["白天", "夜晚"] }, why: ["自動找的日夜對比：這兩個鏡頭角度最像"] };
      delete n.labels; delete n.pip;
      const sh = S().shots, i = sh.lastIndexOf(sh.filter((x) => HC.shotTod(x) === "day").pop());
      sh.splice(i + 1, 0, n);
      renderTimeline(); select(n.id); refresh(); toast("已在白天的最後加上一個日夜對比鏡頭");
    };
    // 浮水印
    const W_ = () => S().wm;
    $("wOn").addEventListener("change", (e) => { HC.commit(); W_().on = e.target.checked; refresh(); });
    $("wText").addEventListener("input", (e) => { W_().text = e.target.value; if (e.target.value && !W_().on) { W_().on = true; $("wOn").checked = true; } refresh(); });
    $("wKindText").onclick = () => { W_().kind = "text"; syncWm(); refresh(); };
    $("wKindImg").onclick = () => { W_().kind = "image"; syncWm(); refresh(); };
    $("wImgIn").addEventListener("change", (e) => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      if (f.size > 2e6) return toast("圖片太大了，請用 2 MB 以下的 PNG");
      const rd = new FileReader();
      rd.onload = () => { W_().img = rd.result; W_().kind = "image"; W_().on = true; syncWm(); refresh(); setTimeout(refresh, 200); };
      rd.readAsDataURL(f);
    });
    $("wCorner").addEventListener("change", (e) => { W_().corner = e.target.value; refresh(); });
    $("wSize").addEventListener("input", (e) => { W_().size = e.target.value / 100; $("wSizeV").textContent = e.target.value + "%"; refresh(); });
    $("wOp").addEventListener("input", (e) => { W_().opacity = e.target.value / 100; $("wOpV").textContent = e.target.value + "%"; refresh(); });
    $("sFocusAuto").onclick = () => edit((s) => { delete s.fx; delete s.fy; });
    // 👍／👎：再按一次取消
    const fb = (val) => {
      const list = targets(); if (!list.length) return;
      HC.commit();
      const on = list.every((s) => s.fb === val) ? 0 : val;
      for (const s of list) { s.fb = on || undefined; if (on) HC.feedback(s, on); }
      renderTimeline(); select(sel, "keep"); renderLearn();
      if (on) toast(on > 0 ? `已記住：${list.length > 1 ? "這些" : "這種"}片段很好` : `已記住：不要再選這種片段${list.length > 1 ? "" : "（想換掉可以按「換一個」）"}`);
    };
    $("sGood").onclick = () => fb(1); $("sBad").onclick = () => fb(-1);
    $("sSwap").onclick = () => {
      const s = cur(); if (!s) return;
      const r = HC.swapShot(s);
      if (!r) return toast("這個場景裡找不到其他可用的片段");
      HC.commit();
      HC.feedback(s, -1, 1);
      Object.assign(s, r); delete s.fb; delete s.fx; delete s.fy;
      s.orig = { start: s.start, dur: s.dur, mode: s.mode, zoom: s.zoom, speed: s.speed };
      renderTimeline(); select(s.id, "keep"); refresh(); HC.stabQueue(stabDone); renderLearn();
    };

    // 時間軸
    const shotsEl = $("shots");
    shotsEl.addEventListener("click", (e) => {
      const el = e.target.closest(".shot"); if (!el || trimDone > performance.now() - 300) return;
      const how = e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : undefined;
      select(el.dataset.id, how);
      if (!how && !R.isPlaying()) seek(HC.timeline().starts[idxOf(el.dataset.id)] + 0.01);
    });
    /* 拖曳左右邊緣修剪：左邊 = 開頭往後裁，右邊 = 結尾。會吸附到播放位置、其他接點和音樂拍點 */
    let trim = null, trimDone = 0;
    shotsEl.addEventListener("pointerdown", (e) => {
      const h = e.target.closest("[data-trim]"); if (!h || R.exporting) return;
      e.preventDefault(); e.stopPropagation();
      const el = h.closest(".shot"), s = S().shots.find((x) => x.id === el.dataset.id); if (!s) return;
      R.stop(); HC.commit();
      el.draggable = false; el.classList.add("trimming");
      const tip = document.createElement("div"); tip.className = "trimtip"; $("tlTrack").appendChild(tip);
      trim = { s, el, h, side: h.dataset.trim, x0: e.clientX, start: s.start, dur: s.dur, tip, i: idxOf(s.id) };
      if (!selSet.has(s.id)) select(s.id);
    });
    window.addEventListener("pointermove", (e) => {
      if (!trim) return;
      const { s, side, i } = trim, p = pps(), c = HC.clip(s.clipId), cd = (c && c.dur) || 1e9;
      let d = (e.clientX - trim.x0) / p * s.speed;   // 素材秒數
      const { starts } = HC.timeline();
      // 吸附：結尾 → 播放位置、拍點；開頭 → 不動（左邊修剪會讓後面整段往前移）
      if (side === "r") {
        const end = starts[i] + (trim.dur + d) / s.speed, snaps = [R.T, ...(HC.beatTimes ? HC.beatTimes() : [])];
        for (const t of snaps) if (Math.abs((t - end) * p) < 7) { d = (t - starts[i]) * s.speed - trim.dur; break; }
        s.dur = +HC.clamp(trim.dur + d, 0.5, cd - s.start).toFixed(2);
      } else {
        const ns = HC.clamp(trim.start + d, 0, trim.start + trim.dur - 0.5);
        s.start = +ns.toFixed(2); s.dur = +(trim.dur - (ns - trim.start)).toFixed(2);
      }
      renderTimeline();
      const el = document.querySelector(`.shot[data-id="${s.id}"]`); if (el) el.classList.add("trimming");
      const T = HC.timeline().starts[i] + (side === "r" ? HC.outDur(s) : 0);
      trim.tip.style.left = T * p + "px"; trim.tip.textContent = side === "r" ? `長度 ${HC.outDur(s).toFixed(1)} 秒` : `素材從 ${HC.fmt(s.start)} 開始`;
      $("tlTrack").appendChild(trim.tip);
    });
    const endTrim = () => {
      if (!trim) return;
      const { s, tip } = trim; tip.remove(); trim = null; trimDone = performance.now();
      HC.noteEdit && HC.noteEdit(s);
      renderTimeline(); select(s.id, "keep"); refresh(); HC.stabQueue(stabDone);
    };
    window.addEventListener("pointerup", endTrim); window.addEventListener("pointercancel", endTrim);
    shotsEl.addEventListener("keydown", (e) => { const el = e.target.closest(".shot"); if (el && e.key === "Enter") el.click(); });
    let dragId = null;
    shotsEl.addEventListener("dragstart", (e) => { const el = e.target.closest(".shot"); if (!el || trim) { e.preventDefault(); return; } dragId = el.dataset.id; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); });
    shotsEl.addEventListener("dragend", () => { dragId = null; document.querySelectorAll(".shot").forEach((x) => x.classList.remove("dragging", "drop-before")); });
    shotsEl.addEventListener("dragover", (e) => { if (!dragId) return; e.preventDefault(); e.stopPropagation(); document.querySelectorAll(".shot").forEach((x) => x.classList.remove("drop-before")); const el = e.target.closest(".shot"); if (el) el.classList.add("drop-before"); });
    shotsEl.addEventListener("drop", (e) => {
      if (!dragId) return;
      e.preventDefault(); e.stopPropagation();
      const a = S().shots, from = a.findIndex((x) => x.id === dragId), el = e.target.closest(".shot");
      let to = el ? a.findIndex((x) => x.id === el.dataset.id) : a.length;
      if (from < 0 || to === from) return;
      HC.commit();
      const [m] = a.splice(from, 1); if (to > from) to--; a.splice(to, 0, m);
      renderTimeline(); select(m.id); refresh();
    });
    const trackSeek = (e) => { if (e.target.closest(".shot")) return; const r = $("tlTrack").getBoundingClientRect(); const T = HC.clamp((e.clientX - r.left) / pps(), 0, HC.timeline().total); R.T = T; movePlayhead(T); seek(T); };
    $("ruler").addEventListener("click", trackSeek);
    $("tlTrack").addEventListener("click", trackSeek);
    $("tlZoom").addEventListener("input", renderTimeline);

    // 自動剪輯設定
    const A = () => S().auto;
    bindVal("aLen", (t) => { A().len = +t.value; A().lenSet = true; });   // 你自己調過長度，就不再用學到的長度蓋掉
    bindVal("aFitMusic", (t) => A().fitMusic = t.checked, "change");
    bindVal("aDedupe", (t) => A().dedupe = t.checked, "change");
    bindVal("aDayNight", (t) => A().dayNight = t.checked, "change");
    bindVal("mBest", (t) => { S().music.autoSec = t.checked; if (t.checked) bestSection(true); }, "change");
    $("recBtn").onclick = async () => {
      $("recBtn").disabled = true;
      try { const r = await HC.applyRecommendation(); bestSection(); toast(`已套用：${r.music ? (r.music.zh || r.music.title) : "（音樂不變）"}${r.amb.length ? "＋" + r.amb.join("、") : ""}`, 4000); }
      catch (e) { toast("套用推薦失敗：" + e.message); }
      $("recBtn").disabled = false;
    };
    $("varBtn").onclick = () => showVariants();
    $("shortBtn").onclick = () => makeShortVersion();
    $("verBtn").onclick = () => showVersions(); bindVal("aRhy", (t) => A().rhythm = t.value / 100);
    bindVal("aSpeed", (t) => A().speed = +t.value, "change"); bindVal("aZoom", (t) => A().zoom = t.value / 100);
    bindVal("aTol", (t) => { A().tol = t.value / 100; for (const c of S().clips) if (c.ana) HC.segmentClip(c, A()); renderBin(); drawSrcGraph(); });
    bindVal("aHead", (t) => A().head = +t.value || 0, "change");
    bindVal("aCursor", (t) => { A().cursor = t.checked; for (const c of S().clips) if (c.ana) HC.segmentClip(c, A()); renderBin(); }, "change");
    bindVal("aBeat", (t) => A().beat = t.checked, "change");
    $("mSnap").onclick = () => { HC.commit(); const n = HC.snapToBeats(S().shots); renderTimeline(); refresh(); toast(n ? `已把 ${n} 個剪接點對齊拍點` : "剪接點都已經在拍點上，或調整幅度太大沒有改"); };
    bindVal("aCover", (t) => A().cover = t.checked, "change"); bindVal("aLateral", (t) => A().lateral = t.checked, "change");
    bindVal("aUI", (t) => { A().ui = t.checked; for (const c of S().clips) if (c.ana) HC.segmentClip(c, A()); renderBin(); drawSrcGraph(); }, "change");
    bindVal("aStab", (t) => A().stab = t.checked, "change"); bindVal("aStabStr", (t) => A().stabStr = t.value / 100);
    bindVal("aLearn", (t) => A().learn = t.checked, "change");

    // 學習
    $("lEdit").onclick = () => {
      if (!S().shots.length) return toast("時間軸是空的");
      const r = HC.learnFromEdits();
      toast(r.ok ? `已學習：保留 ${r.kept}、刪除 ${r.del}、新增 ${r.add} 個鏡頭` : r.why, 3500);
      renderLearn();
    };
    $("refIn").addEventListener("change", async (e) => {
      const files = [...e.target.files]; e.target.value = "";
      for (const [k, f] of files.entries()) {
        const st = $("lRefStatus");
        try {
          const r = await HC.analyzeReference(f, (p) => { st.textContent = `分析參考影片 ${k + 1}/${files.length}：${Math.round(p * 100)}%`; });
          st.textContent = `已學習「${r.name}」：${r.shots} 個鏡頭，平均 ${r.avg.toFixed(1)} 秒`;
        } catch (err) { st.textContent = `「${f.name}」分析失敗：${err.message}`; }
        renderLearn();
      }
    });
    $("lRefs").addEventListener("click", (e) => { const b = e.target.closest("[data-ref]"); if (!b) return; HC.removeReference(+b.dataset.ref); renderLearn(); });
    $("lProf").addEventListener("change", (e) => { HC.profiles.use(e.target.value); renderLearn(); toast(`改用「${e.target.value}」風格，按「自動剪輯」套用`); });
    const askName = (msg, def) => { const n = (prompt(msg, def) || "").trim(); return n || null; };
    $("lNew").onclick = () => { const n = askName("新風格的名字（例如：短影音、慢慢欣賞）", HC.profiles.active() + " 2"); if (!n) return; if (!HC.profiles.create(n, true)) return toast("這個名字已經有了"); renderLearn(); toast(`已建立「${n}」，之後的學習只會改這一套`); };
    $("lRename").onclick = () => { const n = askName("改成什麼名字？", HC.profiles.active()); if (!n || n === HC.profiles.active()) return; if (!HC.profiles.rename(n)) return toast("這個名字已經有了"); renderLearn(); };
    let delArm = 0;
    $("lDel").onclick = () => { if (Date.now() - delArm > 4000) { delArm = Date.now(); return toast(`再按一次「刪除這套」確認刪除「${HC.profiles.active()}」`); } HC.profiles.remove(); renderLearn(); toast("已刪除"); };
    $("lUndo").onclick = () => { if (HC.profiles.undo()) { renderLearn(); toast("已退回上一版"); } };
    $("lExport").onclick = () => saveFile("剪輯風格學習資料.json", JSON.stringify(HC.profile, null, 1));
    $("lImport").addEventListener("change", async (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; try { HC.importProfile(JSON.parse(await f.text())); renderLearn(); toast("已匯入學習資料"); } catch (err) { toast("學習資料檔讀取失敗"); } });
    let resetArm = 0;
    $("lReset").onclick = () => {
      if (Date.now() - resetArm > 4000) { resetArm = Date.now(); return toast("再按一次「全部重設」確認清除學習資料"); }
      HC.resetProfile(); renderLearn(); toast("學習資料已清除");
    };
    bindVal("aGap", (t) => { A().gap = Math.max(0, +t.value || 0); renderBin(); }, "change");
    bindVal("aSceneLook", (t) => { A().sceneLook = t.value / 100; renderBin(); }, "change");
    $("aSceneLook").addEventListener("input", (e) => { $("aSceneV").textContent = sceneLabel(e.target.value / 100); });

    // 標題
    const Ti = () => S().title;
    bindVal("tMain", (t) => Ti().main = t.value); bindVal("tSub", (t) => Ti().sub = t.value); bindVal("tInfo", (t) => Ti().info = t.value);
    bindVal("tAccent", (t) => Ti().accent = t.value);
    const E = () => S().ending;
    bindVal("eTpl", (t) => { E().template = t.value; seekEnd(); }, "change"); bindVal("eMain", (t) => { E().main = t.value; }); bindVal("eSub", (t) => { E().sub = t.value; });
    bindVal("eDur", (t) => { E().dur = Math.max(2, +t.value || 4); }, "change");
    ["eMain", "eSub"].forEach((id) => $(id).addEventListener("focus", seekEnd));
    bindVal("tFont", (t) => { Ti().font = t.value; document.fonts.load(`600 40px "${t.value}"`, Ti().main + Ti().sub).then(refresh); }, "change");
    bindVal("tSize", (t) => Ti().size = HC.clamp(+t.value || 84, 24, 200)); bindVal("tColor", (t) => Ti().color = t.value);
    bindVal("tPos", (t) => Ti().pos = t.value, "change"); bindVal("tLine", (t) => Ti().line = t.checked, "change"); bindVal("tDur", (t) => Ti().dur = Math.max(2, +t.value || 5.5));
    ["tMain", "tSub", "tInfo", "tSize", "tColor", "tDur"].forEach((id) => $(id).addEventListener("focus", () => { if (S().shots.length && !R.isPlaying()) seek(Math.min(2.5, HC.timeline().total)); }));

    // 音樂
    $("musicIn").addEventListener("change", (e) => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      setMusic(f);
    });
    $("mClear").onclick = () => { R.stop(); if (S().music.url) URL.revokeObjectURL(S().music.url); S().music.url = ""; S().music.name = ""; S().music.lib = ""; S().music.file = null; HC.autosave.clearMusic(); HC.analyzeBeats(null); renderTimeline(); renderBeatInfo(); $("musicName").textContent = "尚未選擇（不選就輸出無聲影片）"; };
    bindVal("mVol", (t) => S().music.vol = t.value / 100); bindVal("mOff", (t) => { S().music.off = Math.max(0, +t.value || 0); renderTimeline(); }, "change"); bindVal("mFade", (t) => S().music.fade = Math.max(0, +t.value || 0), "change");

    // 匯出設定
    bindVal("oAspect", (t) => { S().out.aspect = t.value; S().out.preset = ""; $("oPreset").value = ""; applyAspect(); select(sel, "keep"); presetHint(); }, "change");
    bindVal("oMode", (t) => S().out.mode = t.value, "change"); bindVal("oFps", (t) => S().out.fps = +t.value, "change");
    $("oPreset").addEventListener("change", (e) => applyPreset(e.target.value));
    $("thumbBtn").onclick = () => makeThumbs();
    $("chapBtn").onclick = () => makeChapters();
    $("oProxy").addEventListener("change", (e) => { S().out.proxy = e.target.checked; if (e.target.checked) makeProxies(); else { $("oProxyHint").textContent = ""; seek(R.T); } });
    bindVal("oRes", (t) => S().out.res = +t.value, "change"); bindVal("oRate", (t) => S().out.rate = +t.value, "change");
    bindVal("oFi", (t) => S().out.fi = Math.max(0, +t.value || 0), "change"); bindVal("oFo", (t) => S().out.fo = Math.max(0, +t.value || 0), "change");

    // 轉場分頁
    $("trTiles").addEventListener("click", (e) => { const b = e.target.closest("[data-tr]"); if (!b) return; trSel = b.dataset.tr; $("trDur").value = HC.trInfo(trSel).dur || 0.8; renderTiles(); });
    $("trDur").addEventListener("input", () => { $("trDurV").textContent = (+$("trDur").value).toFixed(1) + " 秒"; });
    $("trApply").onclick = () => applyTr(targets().filter((s) => S().shots.indexOf(s) > 0));
    $("trAll").onclick = () => applyTr(S().shots.slice(1));
    $("trScenes").onclick = () => applyTr(S().shots.filter((s, i) => i && HC.boundaryKind(S().shots[i - 1], s) === "gap"));
    // 開頭模板
    $("tTiles").addEventListener("click", (e) => { const b = e.target.closest("[data-tpl]"); if (!b) return; HC.commit(); S().title.template = b.dataset.tpl; renderTiles(); if (S().shots.length) { R.stop(); R.play(0); setTimeout(() => R.isPlaying() && R.T > S().title.dur + 1 && R.stop(), (S().title.dur + 1.5) * 1000); } });
    // 濾鏡與特效
    $("fTiles").addEventListener("click", (e) => { const b = e.target.closest("[data-filter]"); if (!b) return; HC.commit(); S().look.filter = b.dataset.filter; renderTiles(); refresh(); });
    $("fxTiles").addEventListener("click", (e) => {
      const b = e.target.closest("[data-fxid]"); if (!b) return;
      const id = b.dataset.fxid, fx = S().look.fx;
      HC.commit();
      // 第一次點：選取並開啟；已選取時再點：關閉
      if (fxSel === id && fx[id]) fx[id] = 0; else { fxSel = id; if (!fx[id]) fx[id] = +$("fxStr").value / 100 || 0.6; }
      fxSel = id; renderFx(); refresh();
    });
    $("fxTiles").addEventListener("pointerover", (e) => { const b = e.target.closest("[data-fxid]"); if (b) animateFx(b.dataset.fxid); });
    $("fxTiles").addEventListener("pointerleave", () => { animateFx(null); for (const x of HC.EFFECTS) drawFxThumb(x.id, 2.5); });
    $("fxStr").addEventListener("input", () => {
      const v = +$("fxStr").value / 100, fx = S().look.fx;
      fx[fxSel] = v;
      $("fxStrV").textContent = `${HC.EFFECTS.find((x) => x.id === fxSel).name} ${Math.round(v * 100)}%`;
      const b = document.querySelector(`[data-fxid="${fxSel}"]`);
      if (b) { b.classList.add("on"); b.setAttribute("aria-pressed", "true"); let bd = b.querySelector(".badge"); if (!bd) { bd = document.createElement("span"); bd.className = "badge"; b.querySelector(".pv").appendChild(bd); } bd.textContent = Math.round(v * 100) + "%"; }
      drawFxThumb(fxSel, 2.5); refresh();
    });
    // 濾鏡強度、色調濃度：拖的時候即時預覽，放開才記一筆復原
    for (const [id, key] of [["fStr", "filterStr"], ["fTint", "tintStr"]]) {
      let armed = false;
      $(id).addEventListener("input", (e) => {
        if (!armed) { HC.commit(); armed = true; }
        S().look[key] = e.target.value / 100; $(id + "V").textContent = e.target.value + "%"; refresh();
      });
      $(id).addEventListener("change", () => { armed = false; renderTiles(); });
    }
    document.querySelector('[data-tab="look"]').addEventListener("click", () => { snapLook(); renderTiles(); });
    // 自動剪輯：順序、轉場方式
    bindVal("aOrder", (t) => A().order = t.value, "change");
    bindVal("aTrMode", (t) => { A().trMode = t.value; $("aTrTypeRow").classList.toggle("hidden", t.value !== "all"); }, "change");
    bindVal("aTrType", (t) => A().trType = t.value, "change");
    // HyperFrames
    $("hfBtn").onclick = async () => {
      const miss = S().clips.filter((c) => c.missing && S().shots.some((s) => s.clipId === c.id));
      if (miss.length) return toast("還缺素材：" + miss.map((c) => c.name).join("、"), 5000);
      const ov = $("overlay");
      ov.innerHTML = `<strong>防抖分析中…</strong><div class="pbar"><i id="pb"></i></div>`;
      ov.classList.remove("hidden");
      try {
        await HC.stabWaitAll((p) => { $("pb").style.width = (p * 100).toFixed(0) + "%"; });
        ov.querySelector("strong").textContent = "打包 HyperFrames 專案…";
        const name = ($("projName").value || "housing").replace(/[\\/:*?"<>|]/g, "_");
        const blob = await HC.buildHyperframes({ includeClips: $("hfClips").checked, name, onProgress: (p) => { $("pb").style.width = (p * 100).toFixed(0) + "%"; } });
        ov.innerHTML = `<strong>HyperFrames 專案已打包（${(blob.size / 1048576).toFixed(1)} MB）</strong><span class="muted">解壓縮後照 README.md 的步驟渲染</span><button class="btn accent" id="hfDl">下載 ${esc(name)}-hyperframes.zip</button><button class="btn" id="hfClose">關閉</button>`;
        $("hfDl").onclick = () => saveFile(name + "-hyperframes.zip", blob);
        $("hfClose").onclick = () => ov.classList.add("hidden");
      } catch (err) { ov.classList.add("hidden"); toast("打包失敗：" + err.message, 5000); }
    };

    // 快捷鍵
    document.addEventListener("keydown", (e) => {
      const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== "range" && document.activeElement.type !== "checkbox";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { if (typing) return; e.preventDefault(); (e.shiftKey ? $("redoBtn") : $("undoBtn")).click(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { if (typing) return; e.preventDefault(); $("redoBtn").click(); return; }
      if (typing || R.exporting) return;
      const k = e.key, mod = e.ctrlKey || e.metaKey, total = HC.timeline().total;
      const go = (T) => { e.preventDefault(); R.stop(); R.T = HC.clamp(T, 0, total); movePlayhead(R.T); seek(R.T); };
      if ((k === " " && !e.target.closest("button")) || (k.toLowerCase() === "k" && !mod)) { e.preventDefault(); $("playBtn").click(); return; }
      if (mod && k.toLowerCase() === "a") { e.preventDefault(); selSet.clear(); S().shots.forEach((s) => selSet.add(s.id)); select(sel || (S().shots[0] && S().shots[0].id), "keep"); return; }
      if (mod && k.toLowerCase() === "d") { e.preventDefault(); dup(); return; }
      if (e.altKey && !mod && e.code === "KeyC") { e.preventDefault(); copyFx(); return; }
      if (e.altKey && !mod && e.code === "KeyV") { e.preventDefault(); pasteFx(); return; }
      if (mod) return;
      if (k.toLowerCase() === "j") return go(R.T - 2);
      if (k.toLowerCase() === "l") return go(R.T + 2);
      if (k === "ArrowLeft" || k === "ArrowRight") { if (e.target.closest("input,select")) return; return go(R.T + (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / (S().out.fps || 30))); }
      if (k === "Home") return go(0);
      if (k === "End") return go(total);
      if (k.toLowerCase() === "s") { e.preventDefault(); split(); return; }
      if (k === "Escape" && selSet.size > 1) { select(sel); return; }
      if (sel && (k === "Delete" || (k === "Backspace" && e.target.closest(".shot")))) { e.preventDefault(); del(); }
    });
    window.addEventListener("resize", () => { renderTimeline(); drawSrcGraph(); });

    fillSelects(); applyLearnedLook();
    syncForms(); renderBin(); renderTimeline(); renderLearn();
    HC.initLibrary({ toast, setMusic, restart: restartAudio, showText });
    $("tourBtn").onclick = () => tour(0);
    let seen = false; try { seen = !!localStorage.getItem("housingcut.tour"); } catch (e) { seen = true; }
    if (!seen) setTimeout(() => { if (!document.querySelector(".resume")) tour(0); }, 900);
    HC.autosave.start(projectJSON);
    offerResume();
    fontsReady().then(refresh);
  }
  bind();
}
