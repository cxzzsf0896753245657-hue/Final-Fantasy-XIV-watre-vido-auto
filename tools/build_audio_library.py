#!/usr/bin/env python3
"""建立網站內建的免費音樂／音效庫（audio/ 資料夾 + audio/library.json）

只收 CC0 或公有領域的檔案。流程：
  1. 讀 tools/audio_sources.json（來源：Freesound、Internet Archive 上的 Musopen 錄音）（每一項：分類、中文名、原始標題、作者、來源頁、下載網址、授權）
  2. 下載 → 轉成 Opus（WebM 容器）
     - 音樂：音量標準化（約 -16 LUFS），超過 MAX_MUSIC 秒的截短並在結尾淡出
     - 音效：音量標準化（約 -24 LUFS，當背景用），取一段 LOOP 秒，頭尾交叉淡化成可以無縫循環
  3. 寫出 audio/library.json

要加新的音樂或音效：在 audio_sources.json 加一筆（先到來源頁確認是 CC0／公有領域），再跑一次這個程式。
需要：Python 3、numpy、ffmpeg（含 libopus）、curl
"""
import json, os, subprocess, sys, tempfile, re
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", "audio_sources.json")
OUT = os.path.join(ROOT, "audio")
SR = 48000
MAX_MUSIC = 200      # 音樂最長幾秒
LOOP = 75            # 音效循環段長度（秒）
XF = 3.0             # 循環接點交叉淡化（秒）

def run(cmd):
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode: raise RuntimeError(r.stderr.decode(errors="ignore")[-400:])
    return r.stdout

def decode(path, filters):
    raw = run(["ffmpeg", "-v", "error", "-i", path, "-af", filters, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"])
    return np.frombuffer(raw, np.float32).reshape(-1, 2).copy()

def encode(x, path, kbps):
    tmp = path + ".raw"
    x.astype(np.float32).tofile(tmp)
    run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", tmp, "-c:a", "libopus", "-b:a", f"{kbps}k", "-vbr", "on", "-application", "audio", path])
    os.remove(tmp)

UA = "HousingCutAudioLibrary/1.0 (https://github.com/cxzzsf0896753245657-hue/Final-Fantasy-XIV-watre-vido-auto)"
def download(url, f, maxbytes=None):
    """下載；被限速（回傳網頁而不是音檔）就等一下再試。maxbytes：很長的無損檔只抓前面一段就夠了"""
    import time
    for wait in (0, 20, 60, 120, 240):
        time.sleep(wait)
        subprocess.run(["curl", "-sL", "-m", "900", "-A", UA, "-o", f] + (["-r", f"0-{maxbytes}"] if maxbytes else []) + [url])
        with open(f, "rb") as h: head = h.read(64)
        if head and not head.lstrip().lower().startswith((b"<!doctype", b"<html")): return True
    return False

def out_name(it):
    return f'{it["cat"]}/{slug(it["title"])}-{it["id"][:6]}.webm'

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48] or "x"

def main():
    src = json.load(open(SRC, encoding="utf-8"))
    os.makedirs(OUT, exist_ok=True)
    items, failed = [], []
    # 1. 先同時下載（下載很慢，一次抓 8 個）；Wikimedia 會限速，所以那邊一次只抓 1 個
    cache = os.path.join(tempfile.gettempdir(), "housingcut-audio-cache"); os.makedirs(cache, exist_ok=True)
    todo = [it for it in src["items"] if not os.path.exists(os.path.join(OUT, out_name(it)))]
    def fetch(it):
        f = os.path.join(cache, it["id"])
        if os.path.exists(f) and os.path.getsize(f) > 1000: return
        if not download(it["url"], f + ".part", it.get("maxbytes")): return
        os.replace(f + ".part", f)
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(8) as ex: list(ex.map(fetch, [it for it in todo if "wikimedia" not in it["url"]]))
    for it in todo:
        if "wikimedia" in it["url"]: fetch(it)
    print("下載完成", flush=True)
    for it in src["items"]:
        cat = it["cat"]; kind = next(c["kind"] for c in src["cats"] if c["id"] == cat)
        name = out_name(it)
        dst = os.path.join(OUT, name)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst):
            f = os.path.join(cache, it["id"])
            if not os.path.exists(f):
                print(f'略過（下載失敗）：{it["zh"]}', flush=True); failed.append(it["zh"]); continue
            if True:
                if kind == "music":
                    x = decode(f, "loudnorm=I=-16:TP=-1.5:LRA=11")
                    if len(x) > MAX_MUSIC * SR:
                        x = x[: MAX_MUSIC * SR]
                        n = int(4 * SR); x[-n:] *= np.linspace(1, 0, n)[:, None]
                    n = int(0.02 * SR); x[:n] *= np.linspace(0, 1, n)[:, None]
                    encode(x, dst, 64)
                else:
                    x = decode(f, "anull")
                    # 挑最「飽滿穩定」的一段（每秒音量的中位數最高、起伏最小），避免挑到開頭的空白或按鍵聲
                    L = int((LOOP + XF) * SR)
                    if len(x) > L:
                        sec = np.sqrt((x[: len(x) // SR * SR].reshape(-1, SR, 2) ** 2).mean(axis=(1, 2)) + 1e-12)
                        db = 20 * np.log10(sec); W = int(LOOP + XF)
                        best, a = -1e9, 0
                        for st in range(1, max(2, len(db) - W)):
                            win = db[st : st + W]
                            if len(win) < W: break
                            sc = np.median(win) - 0.5 * np.std(win)
                            if sc > best: best, a = sc, st * SR
                        seg = x[a : a + L].copy()
                    else:
                        seg = x.copy()
                    # 音量：當背景用，RMS 約 -26 dBFS
                    # 偶爾的尖峰（樹枝斷裂、時鐘的滴答）不要拉低整段音量：用 99.9% 的峰值算，超過的部分柔和壓下來
                    rms = np.sqrt((seg ** 2).mean() + 1e-12); peak = np.percentile(np.abs(seg), 99.9) + 1e-9
                    seg *= min(10 ** (-26 / 20) / rms, 10 ** (-4 / 20) / peak)
                    lim = 10 ** (-1 / 20); seg = np.tanh(seg / lim) * lim
                    n = int(XF * SR)
                    if len(seg) > 2 * n:
                        body = seg[n:].copy()
                        w = np.linspace(0, 1, n)[:, None]
                        body[-n:] = body[-n:] * np.cos(w * np.pi / 2) + seg[:n] * np.sin(w * np.pi / 2)
                        seg = body
                    encode(seg, dst, 48)
        dur = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", dst]).strip())
        items.append({"id": it["id"][:8], "cat": cat, "zh": it["zh"], "title": it["title"], "creator": it["creator"],
                      "license": it["license"], "page": it["page"], "file": name, "dur": round(dur, 1),
                      **({"vol": it["vol"]} if "vol" in it else {})})
        print(f'{cat:10} {dur:6.1f}s {os.path.getsize(dst)/1e6:5.2f}MB {it["zh"]}', flush=True)
    rank = {it["id"][:8]: k for k, it in enumerate(src["items"])}
    items.sort(key=lambda x: rank[x["id"]])
    json.dump({"cats": src["cats"], "items": items}, open(os.path.join(OUT, "library.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    # 來源清單（GitHub 上看得到）
    with open(os.path.join(OUT, "CREDITS.md"), "w", encoding="utf-8") as h:
        h.write("# 內建音樂與音效的來源\n\n全部是 CC0 或公有領域（Public Domain Mark），可以免費商用、不用標示作者。下表保留原始出處，想註明也可以。\n\n")
        for c in src["cats"]:
            rows = [i for i in items if i["cat"] == c["id"]]
            if not rows: continue
            h.write(f'## {c["name"]}\n\n| 名稱 | 原始標題 | 作者／演奏 | 授權 | 來源 |\n|---|---|---|---|---|\n')
            for i in rows:
                h.write(f'| {i["zh"]} | {i["title"]} | {i["creator"]} | {"CC0" if i["license"] == "cc0" else "公有領域"} | [連結]({i["page"]}) |\n')
            h.write("\n")
    total = sum(os.path.getsize(os.path.join(OUT, i["file"])) for i in items)
    print(f"{len(items)} 個檔案，共 {total/1e6:.1f} MB")
    if failed: print("下載失敗（再跑一次會重試）：", "、".join(failed))

if __name__ == "__main__":
    main()
