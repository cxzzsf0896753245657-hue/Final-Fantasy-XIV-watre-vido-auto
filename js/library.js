/* 免費音樂與音效庫 + 環境音效圖層
   - 檔案放在 audio/ 資料夾，清單是 audio/library.json（分類、標題、作者、長度、授權、來源網址）
   - 全部都是 CC0 或公有領域：可以免費商用、不用標示作者（清單裡還是保留來源，想註明也可以）
   - 背景音樂一首；環境音效最多 3 層，整支影片循環播放
*/
{
  const HC = window.HC;
  const MAX_AMB = 3;
  let lib = null, api = null, kind = "music", cat = "", q = "";
  const preview = new Audio();
  let previewId = "";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

  HC.loadLibrary = async () => {
    if (lib) return lib;
    try { lib = await (await fetch("audio/library.json")).json(); } catch (e) { lib = { cats: [], items: [] }; }
    return lib;
  };
  HC.libCatName = (id) => { const c = lib && lib.cats.find((x) => x.id === id); return c ? c.name : id; };
  HC.libItem = (id) => lib && lib.items.find((x) => x.id === id);
  const libUrl = (it) => "audio/" + it.file;
  async function libFile(it) { const b = await (await fetch(libUrl(it))).blob(); return new File([b], (it.zh || it.title) + "." + it.file.split(".").pop(), { type: b.type || "audio/webm" }); }

  /* ---------- 環境音效圖層 ---------- */
  const audioDur = (url) => new Promise((res) => { const a = new Audio(); a.preload = "metadata"; a.onloadedmetadata = () => res(a.duration || 0); a.onerror = () => res(0); a.src = url; });
  HC.addAmb = async ({ blob, name, lib: libId, vol = 0.5, quiet, key: keep, ext }) => {
    const S = HC.state;
    if (S.amb.length >= MAX_AMB) { api.toast(`環境音效最多 ${MAX_AMB} 層，先移除一層`); return false; }
    const url = URL.createObjectURL(blob), key = keep || HC.uid("a");
    const a = { key, name, url, vol, lib: libId || "", ext: ext || (blob.name && blob.name.includes(".") ? blob.name.split(".").pop() : "webm"), dur: await audioDur(url) };
    S.amb.push(a);
    if (!libId && !keep) HC.autosave.saveAmb(key, name, blob);
    renderAmb(); api.restart();
    if (!quiet) api.toast(`已加入環境音效「${name}」`);
    return true;
  };
  function removeAmb(key) {
    const S = HC.state, i = S.amb.findIndex((a) => a.key === key);
    if (i < 0) return;
    URL.revokeObjectURL(S.amb[i].url);
    HC.autosave.dropAmb(key);
    S.amb.splice(i, 1);
    renderAmb(); api.restart();
  }
  function renderAmb() {
    const A = HC.state.amb;
    $("ambList").innerHTML = A.length ? A.map((a) => `<div class="amb" data-key="${a.key}"><span title="${esc(a.name)}">${esc(a.name)}</span><input type="range" min="0" max="100" value="${Math.round(a.vol * 100)}" aria-label="${esc(a.name)} 音量" data-vol="${a.key}"><button data-rm="${a.key}" aria-label="移除 ${esc(a.name)}" title="移除">✕</button></div>`).join("")
      : `<p class="muted">還沒有。可以疊在音樂下面，例如流水聲、鳥鳴、壁爐。</p>`;
    $("libSfxBtn").disabled = A.length >= MAX_AMB;
  }
  HC.renderAmb = renderAmb;

  /* ---------- 音樂庫 ---------- */
  function render() {
    if (!lib) return;
    // 你常用的分類排前面（從「學習」記下來的）
    const used = ((HC.profile && HC.profile.look && HC.profile.look[kind === "music" ? "music" : "amb"]) || {});
    const rec = HC.state.shots.length ? HC.recommendAudio() : { music: [], amb: [] }, recSet = new Set(kind === "music" ? rec.music : rec.amb);
    const cats = lib.cats.filter((c) => c.kind === kind).sort((a, b) => (recSet.has(b.id) - recSet.has(a.id)) || (used[b.id] || 0) - (used[a.id] || 0));
    if (!cats.some((c) => c.id === cat)) cat = "";
    const count = (id) => lib.items.filter((x) => x.cat === id).length;
    $("libCats").innerHTML = `<button aria-pressed="${!cat}" data-cat="">全部</button>` + cats.map((c) => `<button aria-pressed="${cat === c.id}" data-cat="${c.id}" ${used[c.id] ? 'title="你常用的分類"' : ""}>${recSet.has(c.id) ? "推薦・" : used[c.id] ? "★ " : ""}${esc(c.name)}<small>${count(c.id)}</small></button>`).join("");
    const ql = q.trim().toLowerCase();
    // 有輸入搜尋時搜這一類（音樂／音效）的全部分類
    const items = lib.items.filter((x) => cats.some((c) => c.id === x.cat) && (ql || !cat || x.cat === cat) && (!ql || (x.title + " " + x.creator + " " + x.zh + " " + (lib.cats.find((c) => c.id === x.cat) || {}).name).toLowerCase().includes(ql)));
    const S = HC.state, inUse = (x) => (kind === "music" ? S.music.lib === x.id : S.amb.some((a) => a.lib === x.id));
    $("libList").innerHTML = items.length ? items.map((x) => `
      <div class="li ${inUse(x) ? "on" : ""}">
        <button class="pl" data-play="${x.id}" aria-pressed="${previewId === x.id}" aria-label="試聽 ${esc(x.title)}">${previewId === x.id ? "❚❚" : "▶"}</button>
        <div><b title="${esc(x.title)}">${esc(x.zh || x.title)}</b><span>${esc(x.zh ? x.title + "・" : "")}${esc(x.creator)}・${fmt(x.dur)}・${x.license === "pdm" ? "公有領域" : "CC0"}</span></div>
        <button class="use" data-use="${x.id}">${inUse(x) ? "使用中" : kind === "music" ? "用這首" : "加入"}</button>
      </div>`).join("") : `<p class="muted">找不到符合的項目</p>`;
    $("libNote").innerHTML = `共 ${lib.items.filter((x) => (lib.cats.find((c) => c.id === x.cat) || {}).kind === kind).length} 個${kind === "music" ? "音樂" : "音效"}，全部是 CC0 或公有領域，可以免費商用、不用標示作者。來源：Freesound、Wikimedia Commons（Musopen 等）。` +
      `<a href="#" id="libCredits">看每一首的來源</a>`;
    document.querySelectorAll("#lib .seg button").forEach((b) => b.setAttribute("aria-selected", b.dataset.kind === kind));
  }
  async function open(k) {
    kind = k; cat = ""; q = ""; $("libQ").value = "";
    $("lib").classList.remove("hidden");
    $("libList").innerHTML = `<p class="muted">載入中…</p>`;
    await HC.loadLibrary(); render();
    $("lib").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function stopPreview() { preview.pause(); previewId = ""; }
  async function use(id) {
    const it = HC.libItem(id); if (!it) return;
    stopPreview();
    const c = lib.cats.find((x) => x.id === it.cat);
    if (c.kind === "music") { await api.setMusic(await libFile(it), false, id); }
    else {
      const S = HC.state, have = S.amb.find((a) => a.lib === id);
      if (have) { removeAmb(have.key); api.toast("已移除"); }
      else await HC.addAmb({ blob: await (await fetch(libUrl(it))).blob(), name: it.zh || it.title, lib: id, vol: it.vol || 0.5, ext: it.file.split(".").pop() });
    }
    render();
  }
  function credits() {
    const rows = lib.items.map((x) => `${x.title} — ${x.creator}（${x.license === "pdm" ? "公有領域" : "CC0"}）${x.page}`).join("\n");
    api.showText("音樂與音效來源", rows);
  }

  HC.initLibrary = (a) => {
    api = a;
    renderAmb();
    $("libMusicBtn").onclick = () => open("music");
    $("libSfxBtn").onclick = () => open("sfx");
    $("libClose").onclick = () => { stopPreview(); $("lib").classList.add("hidden"); };
    $("libQ").addEventListener("input", (e) => { q = e.target.value; render(); });
    $("lib").addEventListener("click", (e) => {
      const t = e.target.closest("button,a"); if (!t) return;
      if (t.dataset.kind) { kind = t.dataset.kind; cat = ""; stopPreview(); render(); }
      else if (t.dataset.cat != null) { cat = t.dataset.cat; render(); }
      else if (t.dataset.play) {
        if (previewId === t.dataset.play) stopPreview();
        else { const it = HC.libItem(t.dataset.play); previewId = it.id; preview.src = libUrl(it); preview.volume = 0.8; preview.play().catch(() => { previewId = ""; render(); }); }
        render();
      } else if (t.dataset.use) use(t.dataset.use);
      else if (t.id === "libCredits") { e.preventDefault(); credits(); }
    });
    preview.addEventListener("ended", () => { previewId = ""; render(); });
    $("ambList").addEventListener("input", (e) => {
      const k = e.target.dataset.vol; if (!k) return;
      const a = HC.state.amb.find((x) => x.key === k); if (a) { a.vol = e.target.value / 100; HC.R.music.sync(HC.R.T); }
    });
    $("ambList").addEventListener("click", (e) => { const k = e.target.closest("[data-rm]"); if (k) { removeAmb(k.dataset.rm); render(); } });
    $("ambIn").addEventListener("change", async (e) => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      await HC.addAmb({ blob: f, name: f.name.replace(/\.[^.]+$/, "") });
    });
  };

  /* ---------- 依畫面推薦音樂和環境音 ----------
     看時間軸上的場景類型（庭園／室內）和白天／夜晚；你常用的分類優先 */
  HC.recommendAudio = () => {
    const S = HC.state, cnt = {};
    for (const s of S.shots) { const c = HC.clip(s.clipId); if (!c) continue; const k = (HC.clipType(s.clipId) || "garden") + ":" + (HC.shotTod ? HC.shotTod(s) : "day"); cnt[k] = (cnt[k] || 0) + HC.outDur(s); }
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const amb = [], why = [];
    const add = (arr, ...xs) => { for (const x of xs) if (!arr.includes(x)) arr.push(x); };
    for (const k of top.slice(0, 2)) {
      const [type, tod] = k.split(":");
      if (type === "indoor") { add(amb, tod === "night" ? "fire" : "indoor", "fire"); why.push(tod === "night" ? "室內夜晚 → 壁爐" : "室內 → 生活環境音"); }
      else if (tod === "night") { add(amb, "night", "water"); why.push("夜晚庭園 → 蟲鳴、流水"); }
      else { add(amb, "birds", "water"); why.push("白天庭園 → 鳥鳴、流水"); }
    }
    const fav = HC.profile && HC.profile.look && HC.profile.look.music ? Object.entries(HC.profile.look.music).sort((a, b) => b[1] - a[1]).map(([k]) => k) : [];
    const night = top[0] && top[0].endsWith("night"), short = HC.timeline().total < 75;
    const music = [...fav, ...(short ? ["light", "fantasy"] : night ? ["piano", "ambient", "musicbox"] : ["orchestral", "piano", "guitar"])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
    if (fav.length) why.unshift("音樂：照你常用的分類"); else why.unshift(short ? "影片短 → 輕快的音樂" : night ? "夜晚為主 → 鋼琴、氛圍" : "白天為主 → 管弦樂、鋼琴");
    return { music, amb: amb.slice(0, 2), why };
  };
  /* 套用推薦：第一個音樂分類裡還沒用過的第一首，加上 1～2 層環境音（小聲一點） */
  HC.applyRecommendation = async () => {
    await HC.loadLibrary();
    const r = HC.recommendAudio(), S = HC.state;
    const it = lib.items.find((x) => x.cat === r.music[0] && x.id !== S.music.lib) || lib.items.find((x) => r.music.includes(x.cat));
    if (it) await api.setMusic(await libFile(it), true, it.id);
    for (const a of [...S.amb]) if (a.lib) removeAmb(a.key);
    for (const cat of r.amb) { const x = lib.items.find((y) => y.cat === cat); if (x) await HC.addAmb({ blob: await (await fetch(libUrl(x))).blob(), name: x.zh || x.title, lib: x.id, vol: 0.35, quiet: true, ext: x.file.split(".").pop() }); }
    renderAmb(); render();
    return { music: it, amb: S.amb.map((a) => a.name), why: r.why };
  };

  /* 存檔／還原用 */
  HC.ambForSave = () => HC.state.amb.map((a) => ({ key: a.key, name: a.name, vol: a.vol, lib: a.lib, ext: a.ext }));
  HC.restoreAmb = async (list) => {
    for (const a of HC.state.amb) URL.revokeObjectURL(a.url);
    HC.state.amb = [];
    await HC.loadLibrary();
    for (const a of list || []) {
      let blob = null;
      let ext;
      if (a.lib) { const it = HC.libItem(a.lib); if (it) { blob = await (await fetch(libUrl(it))).blob(); ext = it.file.split(".").pop(); } }
      else { const r = await HC.autosave.amb(a.key); blob = r && r.blob; }
      if (blob) await HC.addAmb({ blob, name: a.name, lib: a.lib, vol: a.vol, quiet: true, key: a.key, ext: ext || a.ext });
    }
    renderAmb();
  };
  HC.libMusicFile = async (id) => { await HC.loadLibrary(); const it = HC.libItem(id); return it ? libFile(it) : null; };
}
