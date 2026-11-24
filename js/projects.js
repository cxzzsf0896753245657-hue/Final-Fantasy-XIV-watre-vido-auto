/* 專案庫：專案依「資料夾」整理，存在這個瀏覽器裡（IndexedDB），可以搜尋、排序、開啟、複製、移動、刪除。
   每個專案也能匯出成一個資料夾（.zip）：project.json、cover.jpg、music/、sounds/，選擇時再加 media/ 影片素材；
   支援的瀏覽器（Chrome／Edge 的獨立分頁）可以直接存到電腦上的資料夾。
   匯入：選整個資料夾，或選 .zip。 */
{
  const HC = window.HC;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let api = null, list = [], folder = "", q = "", sort = "updated", saving = false, covers = new Map();
  const FKEY = "housingcut.folders";
  const extraFolders = () => { try { return JSON.parse(localStorage.getItem(FKEY) || "[]"); } catch (e) { return []; } };
  const setExtraFolders = (a) => { try { localStorage.setItem(FKEY, JSON.stringify([...new Set(a)].sort())); } catch (e) {} };
  const normFolder = (f) => String(f || "").split("/").map((x) => x.trim()).filter(Boolean).join("/");
  const safeName = (s) => String(s || "專案").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80) || "專案";
  const extOf = (n, d) => (n && n.includes(".") ? n.split(".").pop() : d);

  /* ---------- 從目前的編輯狀態做一筆專案 ---------- */
  async function cover() {
    const v = $("view"), c = document.createElement("canvas");
    c.width = 384; c.height = Math.round(384 * v.height / v.width);
    try { c.getContext("2d").drawImage(v, 0, 0, c.width, c.height); } catch (e) { return null; }
    return new Promise((r) => c.toBlob(r, "image/jpeg", 0.8));
  }
  async function snapshot() {
    const S = HC.state, json = api.projectJSON(), o = JSON.parse(json);
    const blobOf = async (url) => { try { return await (await fetch(url)).blob(); } catch (e) { return null; } };
    const music = S.music.url && !S.music.lib ? { name: S.music.name, blob: S.music.file || await blobOf(S.music.url) } : null;
    const amb = [];
    for (const a of S.amb) if (!a.lib) { const b = await blobOf(a.url); if (b) amb.push({ key: a.key, name: a.name, ext: a.ext, blob: b }); }
    const { total } = HC.timeline();
    return {
      json, music, amb, cover: await cover(),
      stats: { shots: S.shots.length, total, clips: S.clips.length, music: S.music.name || "", texts: (S.texts || []).length },
      search: [o.name, ...o.clips.map((c) => c.name), ...(o.texts || []).map((t) => t.text + " " + (t.sub || "")), S.title.main, S.title.sub, S.ending.main, S.music.name, ...S.amb.map((a) => a.name)].join(" ").toLowerCase(),
    };
  }
  async function save(asNew, name, fold, tags) {
    const now = Date.now(), snap = await snapshot();
    const old = !asNew && HC.curProject ? await HC.projectsDB.get(HC.curProject) : null;
    const rec = { ...(old || { id: HC.uid("p"), created: now }), ...snap, name: name || "未命名專案", folder: normFolder(fold), tags: tags || [], updated: now };
    if ((await HC.projectsDB.put(rec)) == null) { api.toast("這個瀏覽器不能存專案庫（可能是無痕模式），請改用「下載專案資料夾」"); return null; }
    HC.curProject = rec.id; covers.delete(rec.id);
    api.setName(rec.name);
    return rec;
  }
  async function quickSave() {
    if (!HC.curProject) return open("save");
    const old = await HC.projectsDB.get(HC.curProject);
    if (!old) return open("save");
    const r = await save(false, api.getName() || old.name, old.folder, old.tags);
    if (r) api.toast(`已存到專案庫：${r.folder ? r.folder + " / " : ""}${r.name}`);
  }
  /* ---------- 開啟 ---------- */
  async function openRec(rec) {
    const o = JSON.parse(rec.json);
    o.name = rec.name;
    if (!o.music.name) api.clearMusic();
    await api.loadProject(o);
    HC.curProject = rec.id;
    if (rec.music && rec.music.blob && !o.music.lib) api.setMusic(new File([rec.music.blob], rec.music.name || "music"), true);
    const custom = new Map((rec.amb || []).map((a) => [a.key, a]));
    if ((o.amb || []).some((a) => !a.lib && custom.has(a.key))) await HC.restoreAmb(o.amb.map((a) => (a.lib ? a : { ...a, blob: (custom.get(a.key) || {}).blob })).filter((a) => a.lib || a.blob));
    close();
  }

  /* ---------- 資料夾（.zip 或電腦上的資料夾） ---------- */
  async function folderFiles(rec, withMedia) {
    const o = JSON.parse(rec.json), out = [{ name: "project.json", data: rec.json }];
    if (rec.cover) out.push({ name: "cover.jpg", data: rec.cover });
    if (rec.music && rec.music.blob) out.push({ name: "music/" + safeName(rec.music.name), data: rec.music.blob });
    for (const a of rec.amb || []) out.push({ name: `sounds/${a.key}.${a.ext || extOf(a.name, "webm")}`, data: a.blob });
    if (withMedia) for (const c of HC.state.clips) if (c.file && o.clips.some((x) => x.name === c.name)) out.push({ name: "media/" + safeName(c.name), data: c.file });
    out.push({ name: "說明.txt", data: `FF14 房屋展示剪輯專案「${rec.name}」\n用剪輯網站的「我的專案 → 匯入資料夾／.zip」打開。\nproject.json = 剪輯設定；music、sounds = 你自己的音樂和音效；media = 影片素材（匯出時有勾選才會有）。\n沒有 media 的話，開啟後再匯入同檔名的素材就會自動對上。\n` });
    return out;
  }
  async function exportZip(rec, withMedia) {
    api.toast("正在打包…");
    const files = await folderFiles(rec, withMedia), root = safeName(rec.name) + "/";
    const blob = await HC.zip(files.map((f) => ({ name: root + f.name, data: f.data })));
    api.saveFile(safeName(rec.name) + ".zip", blob);
  }
  const canDir = () => { try { return typeof window.showDirectoryPicker === "function" && window.self === window.top; } catch (e) { return false; } };
  async function exportDir(rec, withMedia) {
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: "readwrite", id: "housingcut-projects" }); } catch (e) { return; }
    try {
      const sub = await dir.getDirectoryHandle(safeName(rec.name), { create: true });
      for (const f of await folderFiles(rec, withMedia)) {
        const parts = f.name.split("/"); let d = sub;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
        await w.write(typeof f.data === "string" ? new Blob([f.data]) : f.data); await w.close();
      }
      api.toast(`已存到電腦資料夾「${dir.name}/${safeName(rec.name)}」`);
    } catch (e) { api.toast("存到資料夾失敗：" + (e.message || e)); }
  }
  /* 讀 zip（不壓縮或 deflate） */
  async function unzip(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(buf.buffer), dec = new TextDecoder();
    let e = buf.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error("不是 zip 檔");
    const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
    const out = [];
    for (let k = 0; k < n; k++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + xl + cl;
      if (name.endsWith("/")) continue;
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      let data = new Blob([buf.subarray(start, start + csize)]);
      if (method === 8) data = await new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
      else if (method !== 0) continue;
      out.push({ path: name, blob: data });
    }
    return out;
  }
  /* 匯入：files = [{ path, blob }] */
  async function importFiles(files, srcName) {
    const pj = files.find((f) => /(^|\/)project\.json$/i.test(f.path));
    if (!pj) return api.toast("找不到 project.json，這不是專案資料夾");
    const root = pj.path.replace(/project\.json$/i, ""), inRoot = files.filter((f) => f.path.startsWith(root)).map((f) => ({ ...f, rel: f.path.slice(root.length) }));
    const json = await pj.blob.text(), o = JSON.parse(json);
    if (o.app !== "housing-cut") return api.toast("這不是本工具的專案檔");
    const mf = inRoot.find((f) => f.rel.startsWith("music/"));
    const amb = inRoot.filter((f) => f.rel.startsWith("sounds/")).map((f) => { const file = f.rel.slice(7), key = file.replace(/\.[^.]+$/, ""), a = (o.amb || []).find((x) => x.key === key) || {}; return { key, name: a.name || key, ext: extOf(file, "webm"), blob: f.blob }; });
    const cv = inRoot.find((f) => /^cover\.jpe?g$/i.test(f.rel));
    const now = Date.now(), name = o.name || (root.replace(/\/$/, "").split("/").pop()) || srcName || "匯入的專案";
    const rec = { id: HC.uid("p"), created: now, updated: now, name, folder: normFolder(folder), tags: [], json, cover: cv ? cv.blob : null, music: mf ? { name: o.music.name || mf.rel.slice(6), blob: mf.blob } : null, amb,
      stats: { shots: o.shots.length, total: o.shots.reduce((a, s) => a + s.dur / (s.speed || 1), 0), clips: o.clips.length, music: o.music.name || "", texts: (o.texts || []).length },
      search: [name, ...o.clips.map((c) => c.name), ...(o.texts || []).map((t) => t.text)].join(" ").toLowerCase() };
    await HC.projectsDB.put(rec);
    const media = inRoot.filter((f) => f.rel.startsWith("media/"));
    api.toast(`已匯入「${name}」${media.length ? `（含 ${media.length} 支素材）` : ""}`);
    await refreshList();
    if (media.length || confirm(`要現在開啟「${name}」嗎？`)) {
      await openRec(rec);
      if (media.length) api.addFiles(media.map((f) => new File([f.blob], f.rel.slice(6), { type: /\.webm$/i.test(f.rel) ? "video/webm" : "video/mp4" })));
    }
  }

  /* ---------- 介面 ---------- */
  const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  async function refreshList() { list = await HC.projectsDB.all(); render(); }
  function allFolders() {
    const s = new Set(extraFolders());
    for (const r of list) { const parts = (r.folder || "").split("/").filter(Boolean); for (let i = 1; i <= parts.length; i++) s.add(parts.slice(0, i).join("/")); }
    for (const f of [...s]) { const parts = f.split("/"); for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join("/")); }
    return [...s].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }
  const inFolder = (r, f) => !f || r.folder === f || (r.folder || "").startsWith(f + "/");
  function coverUrl(r) { if (!r.cover) return ""; if (!covers.has(r.id)) covers.set(r.id, URL.createObjectURL(r.cover)); return covers.get(r.id); }
  function render() {
    const dlg = $("projDlg"); if (dlg.classList.contains("hidden")) return;
    const folders = allFolders();
    $("pjTree").innerHTML = `<button class="fd ${!folder ? "on" : ""}" data-f="">📁 全部專案 <small>${list.length}</small></button>` +
      folders.map((f) => { const depth = f.split("/").length - 1, n = list.filter((r) => inFolder(r, f)).length; return `<button class="fd ${folder === f ? "on" : ""}" data-f="${esc(f)}" style="padding-left:${12 + depth * 14}px">📁 ${esc(f.split("/").pop())} <small>${n}</small></button>`; }).join("");
    $("pjFolderDl").innerHTML = folders.map((f) => `<option value="${esc(f)}">`).join("");
    const ql = q.trim().toLowerCase(), words = ql.split(/\s+/).filter(Boolean);
    let rows = list.filter((r) => inFolder(r, ql ? "" : folder) && words.every((w) => (r.name + " " + (r.folder || "") + " " + (r.tags || []).join(" ") + " " + (r.search || "")).toLowerCase().includes(w)));
    const cmp = { updated: (a, b) => b.updated - a.updated, created: (a, b) => b.created - a.created, name: (a, b) => a.name.localeCompare(b.name, "zh-Hant"), len: (a, b) => (b.stats?.total || 0) - (a.stats?.total || 0) }[sort];
    rows.sort(cmp);
    $("pjCrumb").textContent = ql ? `搜尋「${q.trim()}」：${rows.length} 個專案（所有資料夾）` : `${folder ? folder.split("/").join(" › ") : "全部專案"}：${rows.length} 個`;
    $("pjGrid").innerHTML = rows.length ? rows.map((r) => `
      <article class="pj ${HC.curProject === r.id ? "cur" : ""}" data-id="${r.id}" draggable="true">
        <div class="pjcv" style="${r.cover ? `background-image:url(${coverUrl(r)})` : ""}">${r.cover ? "" : "沒有封面"}${HC.curProject === r.id ? `<span class="pjnow">編輯中</span>` : ""}</div>
        <div class="pjb">
          <b title="${esc(r.name)}">${esc(r.name)}</b>
          <span class="muted">${r.folder ? "📁 " + esc(r.folder) + " ・ " : ""}${fmtDate(r.updated)}</span>
          <span class="muted">${r.stats ? `${r.stats.shots} 個鏡頭・${HC.fmt(r.stats.total || 0)}・${r.stats.clips} 支素材${r.stats.music ? "・♪" : ""}` : ""}</span>
          ${(r.tags || []).length ? `<span class="pjtags">${r.tags.map((t) => `<i>#${esc(t)}</i>`).join("")}</span>` : ""}
        </div>
        <div class="pjact">
          <button class="btn primary" data-a="open">開啟</button>
          <button class="btn" data-a="edit" title="改名、移到別的資料夾、標籤">改名／移動</button>
          <button class="btn" data-a="dup">複製</button>
          <button class="btn" data-a="zip" title="下載成一個資料夾（.zip）">下載資料夾</button>
          ${canDir() ? `<button class="btn" data-a="dir" title="直接存到電腦上的資料夾">存到電腦</button>` : ""}
          <button class="btn danger" data-a="del">刪除</button>
        </div>
      </article>`).join("") : `<p class="muted pjempty">${ql ? "找不到符合的專案" : "這個資料夾還沒有專案。按上面的「儲存目前的專案」存進來，或匯入專案資料夾。"}</p>`;
  }
  function showSave(rec, mode) {
    const f = $("pjSave"), cur = mode === "edit" ? rec : null;
    saving = mode;
    f.dataset.id = rec ? rec.id : "";
    $("pjSaveTitle").textContent = mode === "edit" ? "改名／移動" : "儲存目前的專案";
    $("pjName").value = cur ? cur.name : (api.getName() || (rec && rec.name) || "");
    $("pjFolder").value = cur ? cur.folder || "" : (rec ? rec.folder || "" : folder);
    $("pjTags").value = cur ? (cur.tags || []).join("、") : (rec ? (rec.tags || []).join("、") : "");
    $("pjUpdate").classList.toggle("hidden", mode !== "save" || !rec);
    $("pjUpdate").textContent = rec ? `更新「${rec.name}」` : "";
    $("pjNew").textContent = mode === "edit" ? "確定" : rec ? "另存成新專案" : "儲存";
    f.classList.remove("hidden"); $("pjName").focus(); $("pjName").select();
  }
  async function submitSave(asNew) {
    const name = $("pjName").value.trim() || "未命名專案", fold = normFolder($("pjFolder").value), tags = $("pjTags").value.split(/[,，、\s]+/).map((t) => t.replace(/^#/, "")).filter(Boolean);
    if (saving === "edit") {
      const r = await HC.projectsDB.get($("pjSave").dataset.id); if (!r) return;
      Object.assign(r, { name, folder: fold, tags }); await HC.projectsDB.put(r);
      if (HC.curProject === r.id) api.setName(name);
      api.toast("已更新");
    } else {
      const r = await save(asNew, name, fold, tags);
      if (r) api.toast(`已存到專案庫：${r.folder ? r.folder + " / " : ""}${r.name}`);
    }
    if (fold) folder = fold;
    $("pjSave").classList.add("hidden"); saving = false;
    await refreshList();
  }
  async function open(mode) {
    $("projDlg").classList.remove("hidden");
    await refreshList();
    if (mode === "save") showSave(HC.curProject ? await HC.projectsDB.get(HC.curProject) : null, "save");
    else { $("pjSave").classList.add("hidden"); $("pjQ").focus(); }
  }
  function close() { $("projDlg").classList.add("hidden"); $("pjSave").classList.add("hidden"); }

  HC.initProjects = (a) => {
    api = a;
    $("saveBtn").onclick = () => open("save");
    $("openBtn").onclick = () => open("browse");
    $("pjClose").onclick = close;
    $("projDlg").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); if (!$("pjSave").classList.contains("hidden")) $("pjSave").classList.add("hidden"); else close(); } });
    $("pjSaveCur").onclick = async () => showSave(HC.curProject ? await HC.projectsDB.get(HC.curProject) : null, "save");
    $("pjUpdate").onclick = () => submitSave(false);
    $("pjNew").onclick = () => submitSave(saving === "save");
    $("pjCancel").onclick = () => { $("pjSave").classList.add("hidden"); saving = false; };
    $("pjSave").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); submitSave(saving === "save" && !HC.curProject); } });
    $("pjQ").addEventListener("input", (e) => { q = e.target.value; render(); });
    $("pjSort").addEventListener("change", (e) => { sort = e.target.value; render(); });
    $("pjNewFolder").onclick = () => {
      const n = prompt("新資料夾名稱（可以用 / 建子資料夾，例如：客戶/小明）", folder ? folder + "/" : "");
      const f = normFolder(n); if (!f) return;
      setExtraFolders([...extraFolders(), f]); folder = f; render();
    };
    $("pjTree").addEventListener("click", (e) => { const b = e.target.closest(".fd"); if (b) { folder = b.dataset.f; q = ""; $("pjQ").value = ""; render(); } });
    // 把專案拖到左邊的資料夾 = 移動
    $("pjGrid").addEventListener("dragstart", (e) => { const c = e.target.closest(".pj"); if (c) { e.dataTransfer.setData("text/x-proj", c.dataset.id); e.dataTransfer.effectAllowed = "move"; } });
    $("pjTree").addEventListener("dragover", (e) => { const b = e.target.closest(".fd"); if (b && e.dataTransfer.types.includes("text/x-proj")) { e.preventDefault(); document.querySelectorAll("#pjTree .drop").forEach((x) => x.classList.remove("drop")); b.classList.add("drop"); } });
    $("pjTree").addEventListener("dragleave", (e) => { const b = e.target.closest(".fd"); if (b) b.classList.remove("drop"); });
    $("pjTree").addEventListener("drop", async (e) => {
      const b = e.target.closest(".fd"), id = e.dataTransfer.getData("text/x-proj"); if (!b || !id) return;
      e.preventDefault(); b.classList.remove("drop");
      const r = await HC.projectsDB.get(id); if (!r) return;
      r.folder = b.dataset.f; await HC.projectsDB.put(r); api.toast(`已移到「${b.dataset.f || "全部專案（最上層）"}」`); refreshList();
    });
    $("pjGrid").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-a]"), card = e.target.closest(".pj"); if (!card) return;
      const r = list.find((x) => x.id === card.dataset.id); if (!r) return;
      const act = btn ? btn.dataset.a : e.target.closest(".pjcv") ? "open" : null; if (!act) return;
      if (act === "open") openRec(r);
      else if (act === "edit") showSave(r, "edit");
      else if (act === "dup") { const now = Date.now(); await HC.projectsDB.put({ ...r, id: HC.uid("p"), name: r.name + " 副本", created: now, updated: now }); api.toast("已複製"); refreshList(); }
      else if (act === "zip") exportZip(r, $("pjMedia").checked && HC.curProject === r.id);
      else if (act === "dir") exportDir(r, $("pjMedia").checked && HC.curProject === r.id);
      else if (act === "del") { if (!confirm(`刪除專案「${r.name}」？（影片素材不會被刪）`)) return; await HC.projectsDB.del(r.id); if (HC.curProject === r.id) HC.curProject = null; refreshList(); }
    });
    $("pjDirIn").addEventListener("change", async (e) => {
      const fs = [...e.target.files]; e.target.value = ""; if (!fs.length) return;
      try { await importFiles(fs.map((f) => ({ path: f.webkitRelativePath || f.name, blob: f })), ""); } catch (err) { api.toast("匯入失敗：" + (err.message || err)); }
    });
    $("pjZipIn").addEventListener("change", async (e) => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      try {
        if (/\.json$/i.test(f.name)) return importFiles([{ path: "project.json", blob: f }], f.name.replace(/\.json$/i, ""));
        await importFiles(await unzip(f), f.name.replace(/\.zip$/i, ""));
      } catch (err) { api.toast("匯入失敗：" + (err.message || err)); }
    });
    addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); quickSave(); } });
  };
  HC.openProjects = open;
  HC.projectUnzip = unzip;
}
