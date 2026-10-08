# -*- coding: utf-8 -*-
"""NSFW Studio - 本地专属图像控制台后端。

职责：
  1. 托管 static/ 下的前端页面；
  2. 代理本地 ComfyUI（提交工作流 / 轮询历史 / 取图 / 中断），规避浏览器跨域；
  3. 提供含项目身份的就绪探针 /health/ready；
  4. 监听 ControlHub 协作停止事件（Local\\AIHome.TaskStop.*），被触发后优雅退出。

仅监听 127.0.0.1，不对外暴露。运行：python server.py [--no-browser]
"""
import http.server
import socketserver
import json
import urllib.parse
import os
import re
import sys
import hashlib
import threading
import ctypes
import base64
import subprocess
import time
from ctypes import wintypes
import webbrowser

import requests
import batch_worker

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
COMFY = "http://127.0.0.1:8188"
COMFY_ROOT = os.path.normpath(os.path.join(ROOT, "..", "comfyui", "app"))
COMFY_INPUT = os.path.join(COMFY_ROOT, "input")
CHARACTER_SUBDIR = "characters"
OUTFIT_SUBDIR = "outfits"
COMFY_OUTPUT = os.path.join(COMFY_ROOT, "output")
PORT = 8189
SERVICE_ID = "nsfw-studio"
TASK_PATH = r"\AIHome\NSFWStudio"

LOGDIR = os.path.join(ROOT, "runtime", "logs")
try:
    os.makedirs(LOGDIR, exist_ok=True)
except OSError:
    pass
LOGFILE = os.path.join(LOGDIR, "nsfwstudio.log")
PROMPTLIB_FILE = os.path.join(ROOT, "runtime", "promptlib.json")
BATCH_LOGDIR = os.path.normpath(os.path.join(ROOT, "..", "comfyui", "temp", "logs"))
BATCH_OUTPUT = os.path.join(COMFY_OUTPUT, "千问批量")
# 外部千问批量脚本（用户自己的脚本，由控制台启停；非 AIHome 生命周期对象）
COMFY_PROJECT = os.path.normpath(os.path.join(ROOT, "..", "comfyui"))
EXT_BATCH_SCRIPT = os.path.join(COMFY_PROJECT, "temp", "qwen_batch20.py")
EXT_BATCH_PYTHON = os.path.join(COMFY_PROJECT, "venv", "Scripts", "python.exe")
EXT_BATCH_FLAGS_DIR = os.path.join(COMFY_PROJECT, "temp", "flags")
EXT_BATCH_STOP_FLAG = os.path.join(EXT_BATCH_FLAGS_DIR, "qwen_batch_stop.flag")
EXT_BATCH_MARKER = os.path.join(EXT_BATCH_FLAGS_DIR, "qwen_batch.running.json")
EXT_BATCH_LAUNCH_LOG = os.path.join(BATCH_LOGDIR, "qwen_batch_launcher.out.log")
EXT_BATCH_CLIENT = "qwen-batch20-v2"
EXT_BATCH_HEARTBEAT_MAX_AGE = 300   # 秒：运行标记心跳超过该时长视为陈旧（脚本被杀/重启）
# 生成中心：散图条目编号池（与提示词包条目的 1-999 号段隔离，散图从 1000 起）
GEN_ID_POOL_FILE = os.path.join(ROOT, "runtime", "id_pool.json")
GEN_ID_START = 1000
# 生成中心"AI 包"来源的默认包目录
DEFAULT_PACK_DIR = os.path.normpath(os.path.join(COMFY_PROJECT, "temp", "prompts20"))
FAVORITES_FILE = os.path.join(ROOT, "runtime", "favorites.json")
HISTORY_FILE = os.path.join(ROOT, "runtime", "history.json")
TEMPLATES_FILE = os.path.join(ROOT, "runtime", "templates.json")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def local_image_path(kind, subfolder, filename):
    """把 ComfyUI 的 (type, subfolder, filename) 解析成本地绝对路径。

    存在且未越界时返回路径，否则返回 None。
    """
    base = {"output": COMFY_OUTPUT,
            "input": COMFY_INPUT,
            "temp": os.path.join(COMFY_ROOT, "temp")}.get(kind or "output")
    if not base or not filename:
        return None
    base = os.path.normpath(base)
    fp = os.path.normpath(os.path.join(base, (subfolder or "").replace("/", os.sep), filename))
    if not fp.startswith(base + os.sep):
        return None
    return fp if os.path.isfile(fp) else None


def build_prompt(p):
    """根据前端参数组装 Qwen-Image-2.1（破甲 GGUF）工作流。

    无 lock_image：文生图；提供 lock_image（input 相对路径）：参考图锁脸/锁身材。
    """
    w = int(p["width"])
    h = int(p["height"])
    batch = int(p.get("batch", 1))
    lock = p.get("lock_image")
    img2img = p.get("img2img_image")
    denoise = float(p.get("denoise", 1.0))

    enc_inputs = {
        "clip": ["11", 0],
        "prompt": p["positive"],
        "negative_prompt": p["negative"],
        "resolution": 1024,
    }
    prompt = {
        "10": {"class_type": "UnetLoaderGGUF",
               "inputs": {"unet_name": "qwen-image-2.1-UC-Q4_0.gguf"}},
        "11": {"class_type": "CLIPLoader",
               "inputs": {"clip_name": "qwen3vl_8b_w4a8.safetensors",
                          "type": "qwen_image", "device": "cpu"}},
        "12": {"class_type": "VAELoader",
               "inputs": {"vae_name": "qwen_image_2.1_vae_bf16.safetensors"}},
        "22": {"class_type": "EmptyLatentImage",
               "inputs": {"width": w, "height": h, "batch_size": batch}},
        "23": {"class_type": "KSampler", "inputs": {
            "model": ["10", 0],
            "seed": int(p["seed"]),
            "steps": int(p["steps"]),
            "cfg": float(p["cfg"]),
            "sampler_name": "euler",
            "scheduler": "simple",
            "positive": ["13", 0],
            "negative": ["13", 1],
            "latent_image": ["22", 0],
            "denoise": denoise}},
        "24": {"class_type": "VAEDecode",
               "inputs": {"samples": ["23", 0], "vae": ["12", 0]}},
        "25": {"class_type": "SaveImage",
               "inputs": {"images": ["24", 0],
                          "filename_prefix": p.get("prefix", "nsfw-studio/batch")}},
    }
    if lock:
        prompt["30"] = {"class_type": "LoadImage",
                        "inputs": {"image": lock}}
        # 参考图走 TextEncodeQwenImage21 的 autogrow 组，API 键名必须是 "images.image_N"
        enc_inputs["images.image_1"] = ["30", 0]
        enc_inputs["vae"] = ["12", 0]
    outfit = p.get("outfit_image")
    if outfit:
        prompt["31"] = {"class_type": "LoadImage",
                        "inputs": {"image": outfit}}
        enc_inputs["images.image_2"] = ["31", 0]
        enc_inputs["vae"] = ["12", 0]
    # 图生图：用 LoadImage + VAEEncode 替代 EmptyLatentImage
    if img2img:
        prompt["32"] = {"class_type": "LoadImage",
                        "inputs": {"image": img2img}}
        prompt["33"] = {"class_type": "VAEEncode",
                        "inputs": {"pixels": ["32", 0], "vae": ["12", 0]}}
        prompt["23"]["inputs"]["latent_image"] = ["33", 0]
    prompt["13"] = {"class_type": "TextEncodeQwenImage21", "inputs": enc_inputs}
    return prompt


def build_upscale_prompt(im):
    """对一张已生成图用 SeedVR2-1.4B (6层蒸馏版) 进行4倍超分并保存。
    轻量扩散超分：~20-30秒/张，4.6GB显存，真正重建细节而非纯插值。
    工作流: LoadImage → ImageScaleBy(4x) → SeedVR2Preprocess → VAEEncodeTiled
            → SeedVR2Conditioning → KSampler(1步) → VAEDecodeTiled → SeedVR2PostProcessing → Save
    """
    sub = im.get("subfolder", "")
    rel = (sub + "/" + im["filename"]) if sub else im["filename"]
    image_value = "%s [%s]" % (rel, im.get("type", "output"))
    return {
        # 1. 加载原图
        "40": {"class_type": "LoadImageOutput", "inputs": {"image": image_value}},
        # 2. 加载SeedVR2-1.4B模型
        "41": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "seedvr2_distill_6L_1.4B_sharp_fp16_comfyui.safetensors",
            "weight_dtype": "default"}},
        # 3. 加载SeedVR2 VAE
        "42": {"class_type": "VAELoader", "inputs": {
            "vae_name": "seedvr2_ema_vae_fp16.safetensors"}},
        # 4. 4倍缩放（lanczos插值，作为SeedVR2的输入基础）
        "43": {"class_type": "ImageScaleBy", "inputs": {
            "image": ["40", 0], "upscale_method": "lanczos", "scale_by": 4}},
        # 5. SeedVR2预处理
        "44": {"class_type": "SeedVR2Preprocess", "inputs": {
            "resized_images": ["43", 0]}},
        # 6. VAE编码（分块，tile_size=512防止OOM）
        "45": {"class_type": "VAEEncodeTiled", "inputs": {
            "pixels": ["44", 0], "vae": ["42", 0],
            "tile_size": 512, "overlap": 64,
            "temporal_size": 64, "temporal_overlap": 8}},
        # 7. SeedVR2条件化（从模型和latent生成positive/negative）
        "46": {"class_type": "SeedVR2Conditioning", "inputs": {
            "model": ["41", 0], "vae_conditioning": ["45", 0]}},
        # 8. 一步采样（steps=1, cfg=1, euler, simple, denoise=1）
        "47": {"class_type": "KSampler", "inputs": {
            "model": ["41", 0],
            "positive": ["46", 0],
            "negative": ["46", 1],
            "latent_image": ["45", 0],
            "seed": 42,
            "steps": 1,
            "cfg": 1,
            "sampler_name": "euler",
            "scheduler": "simple",
            "denoise": 1}},
        # 9. VAE解码（分块）
        "48": {"class_type": "VAEDecodeTiled", "inputs": {
            "samples": ["47", 0], "vae": ["42", 0],
            "tile_size": 512, "overlap": 64,
            "temporal_size": 64, "temporal_overlap": 8}},
        # 10. SeedVR2后处理（色彩校正）
        "49": {"class_type": "SeedVR2PostProcessing", "inputs": {
            "images": ["48", 0],
            "original_resized_images": ["43", 0],
            "color_correction_method": "none"}},
        # 11. 保存结果
        "50": {"class_type": "SaveImage", "inputs": {
            "images": ["49", 0], "filename_prefix": "upscale-seedvr2/高清"}},
    }



# ---------- 图库辅助 ----------
def gallery_list_dirs():
    dirs = []
    if not os.path.isdir(COMFY_OUTPUT):
        return dirs
    for name in os.listdir(COMFY_OUTPUT):
        fp = os.path.join(COMFY_OUTPUT, name)
        if not os.path.isdir(fp):
            continue
        count = 0
        latest = 0
        for root, _dirs, files in os.walk(fp):
            for fn in files:
                if fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                    count += 1
                    try:
                        mt = os.path.getmtime(os.path.join(root, fn))
                        if mt > latest:
                            latest = mt
                    except OSError:
                        pass
        if count > 0:
            dirs.append({"name": name, "count": count, "latest": latest})
    dirs.sort(key=lambda d: d["latest"], reverse=True)
    return dirs


# ---------- PNG 元数据提取 ----------
PROMPT_CACHE_FILE = os.path.join(ROOT, "runtime", "prompt_cache.json")
_prompt_cache = {}
_prompt_cache_dirty = False

def load_prompt_cache():
    """启动时从磁盘恢复提示词缓存（路径+mtime 校验），避免重启后首次搜索全量开图。"""
    global _prompt_cache
    try:
        with open(PROMPT_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            _prompt_cache = {k: (v[0], v[1]) for k, v in data.items()
                             if isinstance(v, list) and len(v) == 2}
    except Exception:
        _prompt_cache = {}

def flush_prompt_cache():
    global _prompt_cache_dirty
    if not _prompt_cache_dirty:
        return
    try:
        os.makedirs(os.path.dirname(PROMPT_CACHE_FILE), exist_ok=True)
        snapshot = dict(_prompt_cache)  # 快照，避免并发写导致遍历异常
        with open(PROMPT_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump({k: [v[0], v[1]] for k, v in snapshot.items()}, f, ensure_ascii=False)
        _prompt_cache_dirty = False
    except Exception:
        pass

def _prompt_cache_flusher():
    while True:
        time.sleep(15)
        flush_prompt_cache()

def extract_prompt_from_png(fp):
    """从 ComfyUI 保存的 PNG 中提取正面提示词摘要（mtime 缓存 + 落盘持久化）。"""
    global _prompt_cache_dirty
    try:
        mtime = os.path.getmtime(fp)
        key = fp
        cached = _prompt_cache.get(key)
        if cached and cached[0] == mtime:
            return cached[1]
        from PIL import Image
        img = Image.open(fp)
        raw = img.info.get("prompt", "")
        if not raw:
            _prompt_cache[key] = (mtime, "")
            _prompt_cache_dirty = True
            return ""
        data = json.loads(raw)
        result = ""
        for node_id, node in data.items():
            if not isinstance(node, dict):
                continue
            ct = node.get("class_type", "")
            inputs = node.get("inputs", {})
            # Qwen-Image: TextEncodeQwenImage21, prompt 字段
            if ct == "TextEncodeQwenImage21" and "prompt" in inputs:
                t = inputs["prompt"]
                if isinstance(t, str) and t.strip():
                    result = t.strip()
                    break
            # 标准 SD: CLIPTextEncode, text 字段
            elif ct == "CLIPTextEncode" and "text" in inputs:
                t = inputs["text"]
                if isinstance(t, str) and t.strip():
                    result = t.strip()
                    break
        _prompt_cache[key] = (mtime, result)
        _prompt_cache_dirty = True
        return result
    except Exception:
        # 负缓存：打不开的文件（例如外部批量正在写入）也记下当前 mtime，避免每次搜索反复重试；
        # 文件写完 mtime 会变，届时自动重新提取
        try:
            _prompt_cache[fp] = (os.path.getmtime(fp), "")
            _prompt_cache_dirty = True
        except OSError:
            pass
        return ""

def png_size(fp):
    """只读 PNG 头（IHDR）取宽高，不解码整图；非 PNG 或读取失败返回 (0, 0)。"""
    try:
        with open(fp, "rb") as f:
            head = f.read(24)
        if len(head) >= 24 and head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
            return (int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big"))
    except OSError:
        pass
    return (0, 0)


def png_complete(fp):
    """判断本地 PNG 是否已写完（末尾 32 字节内应含 IEND 块）。

    正在写入 / 中断的文件若直接发给浏览器，会解码失败显示断图（用户实测反馈）。
    非 PNG 或读取失败时不做拦截，交给后续原有逻辑处理。
    """
    try:
        if not fp.lower().endswith(".png"):
            return True
        size = os.path.getsize(fp)
        if size < 16:
            return False
        with open(fp, "rb") as f:
            f.seek(max(0, size - 32))
            tail = f.read(32)
        return b"IEND" in tail
    except OSError:
        return True


def gallery_list_images(subfolder="", page=1, size=48, search="", only_favorites=False):
    """分页列出图库图片。

    先做不打开 PNG 的元数据扫描，排序分页后只为当前页提取提示词；
    仅当传入 search 时才按需打开 PNG 做全文匹配（文件名/目录名可命中的仍会跳过）。
    """
    target = COMFY_OUTPUT
    if subfolder:
        target = os.path.join(COMFY_OUTPUT, subfolder)
    favs = favorites_load() if only_favorites else set()
    search_lower = search.lower().strip() if search else ""
    entries = []
    if os.path.isdir(target):
        for root, _dirs, files in os.walk(target):
            for fn in files:
                if fn.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                    fp = os.path.join(root, fn)
                    try:
                        st = os.stat(fp)
                    except OSError:
                        continue
                    rel = os.path.relpath(os.path.dirname(fp), COMFY_OUTPUT)
                    if rel == ".":
                        rel = ""
                    rel = rel.replace("\\", "/")
                    key = (rel + "/" + fn) if rel else fn
                    if only_favorites and key not in favs:
                        continue
                    entries.append({
                        "filename": fn, "subfolder": rel, "type": "output",
                        "size": st.st_size, "mtime": st.st_mtime,
                        "key": key, "fp": fp,
                    })
    entries.sort(key=lambda x: x["mtime"], reverse=True)
    if search_lower:
        hit = []
        for e in entries:
            if search_lower in (e["filename"] + " " + e["subfolder"]).lower():
                hit.append(e)
            elif search_lower in extract_prompt_from_png(e["fp"]).lower():
                hit.append(e)
        entries = hit
    total = len(entries)
    start = (page - 1) * size
    images = []
    for e in entries[start:start + size]:
        w, h = png_size(e["fp"])
        images.append({
            "filename": e["filename"],
            "subfolder": e["subfolder"],
            "type": "output",
            "size": e["size"],
            "mtime": e["mtime"],
            "prompt": extract_prompt_from_png(e["fp"])[:120],
            "favorite": e["key"] in favs,
            "width": w,
            "height": h,
        })
    return {"images": images, "total": total, "page": page, "size": size}

def favorites_load():
    try:
        with open(FAVORITES_FILE, "r", encoding="utf-8") as f:
            return set(json.load(f))
    except Exception:
        return set()

def favorites_save(s):
    try:
        os.makedirs(os.path.dirname(FAVORITES_FILE), exist_ok=True)
        with open(FAVORITES_FILE, "w", encoding="utf-8") as f:
            json.dump(sorted(list(s)), f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def favorites_toggle(key):
    favs = favorites_load()
    if key in favs:
        favs.discard(key)
        favorites_save(favs)
        return False
    else:
        favs.add(key)
        favorites_save(favs)
        return True

def history_load():
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []

def history_save(items):
    try:
        os.makedirs(os.path.dirname(HISTORY_FILE), exist_ok=True)
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def history_add(record):
    items = history_load()
    record["id"] = int(time.time() * 1000)
    record["created_at"] = time.time()
    items.insert(0, record)
    # 最多保留 500 条
    if len(items) > 500:
        items = items[:500]
    history_save(items)
    return record

def history_clear():
    history_save([])

def templates_load():
    try:
        with open(TEMPLATES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []

def templates_save(items):
    try:
        os.makedirs(os.path.dirname(TEMPLATES_FILE), exist_ok=True)
        with open(TEMPLATES_FILE, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def templates_add(tpl):
    items = templates_load()
    tpl["id"] = int(time.time() * 1000)
    tpl["created_at"] = time.time()
    items.append(tpl)
    templates_save(items)
    return tpl

def templates_delete(tid):
    items = templates_load()
    items = [x for x in items if x.get("id") != tid]
    templates_save(items)


# ---------- 生成中心：解析 / 编号池 / 命名 / 提示词包 ----------
def parse_prompt_txt(text):
    """Prompt Spec v1 解析（与 qwen_batch20.py / tools/prompt_pack.py 同一套规则）。

    utf-8-sig 剥离 BOM 后按行解析；"#" 开头为注释；"NEG:"（兼容全角）之后并入负面。
    返回 (positive, negative)，均保留换行。
    """
    pos, neg, in_neg = [], [], False
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.upper().startswith(("NEG:", "NEG：")):
            in_neg = True
            rest = s[4:].strip()
            if rest:
                neg.append(rest)
            continue
        (neg if in_neg else pos).append(s)
    return "\n".join(pos).strip(), "\n".join(neg).strip()


def gene_id_pool_load():
    try:
        with open(GEN_ID_POOL_FILE, "r", encoding="utf-8") as f:
            d = json.load(f)
        return max(GEN_ID_START, int(d.get("next_id", GEN_ID_START)))
    except Exception:
        return GEN_ID_START


def gene_ids_alloc(n):
    """分配 n 个连续的散图条目编号（与提示词包 1-999 号段隔离，从 1000 起）。"""
    with DATA_LOCK:
        start = gene_id_pool_load()
        try:
            os.makedirs(os.path.dirname(GEN_ID_POOL_FILE), exist_ok=True)
            with open(GEN_ID_POOL_FILE, "w", encoding="utf-8") as f:
                json.dump({"next_id": start + n}, f, ensure_ascii=False)
        except OSError:
            pass
    return list(range(start, start + n))


def _safe_name(s, fallback="未命名"):
    """用于目录/文件名的名称清洗（去掉非法字符并限长；保留下划线）。"""
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", (s or "").strip())
    s = s.strip(" .")[:40]
    return s or fallback


def pack_status(d):
    """提示词包状态：manifest 条目 + 每条已完成张数（按 <ID>_第 前缀计数）。"""
    st = {"dir": d, "name": "", "params": {}, "items": [], "error": None}
    if not os.path.isdir(d):
        st["error"] = "目录不存在：%s" % d
        return st
    mp = os.path.join(d, "manifest.json")
    if not os.path.isfile(mp):
        st["error"] = "缺少 manifest.json（先运行 tools/prompt_pack.py init）"
        return st
    try:
        with open(mp, "r", encoding="utf-8-sig") as f:
            man = json.load(f)
    except Exception as e:
        st["error"] = "manifest 读取失败：%s" % e
        return st
    st["name"] = man.get("name", "")
    st["params"] = man.get("params", {})
    try:
        cp = int(st["params"].get("count_per", 16) or 16)
    except (TypeError, ValueError):
        cp = 16
    for it in man.get("items", []):
        try:
            eid = int(it.get("id", 0) or 0)
        except (TypeError, ValueError):
            eid = 0
        stem = os.path.splitext(it.get("file", ""))[0]
        outdir = os.path.join(BATCH_OUTPUT, stem)
        done = 0
        if eid and os.path.isdir(outdir):
            pre = "%02d_第" % eid
            try:
                done = sum(1 for fn in os.listdir(outdir)
                           if fn.startswith(pre) and fn.lower().endswith(".png"))
            except OSError:
                pass
        try:
            cnt = int(it.get("count") or cp)
        except (TypeError, ValueError):
            cnt = cp
        st["items"].append({
            "id": eid, "file": it.get("file", ""), "title": it.get("title", ""),
            "category": it.get("category", ""), "enabled": it.get("enabled", True),
            "count": cnt, "done": done,
        })
    return st


def gallery_delete(images):
    deleted = 0
    failed = 0
    for im in images:
        try:
            sub = im.get("subfolder", "")
            fn = im.get("filename", "")
            if not fn:
                failed += 1
                continue
            fp = os.path.join(COMFY_OUTPUT, sub, fn) if sub else os.path.join(COMFY_OUTPUT, fn)
            if os.path.isfile(fp):
                os.remove(fp)
                deleted += 1
            else:
                failed += 1
        except Exception:
            failed += 1
    return {"deleted": deleted, "failed": failed}



# ---------- 服饰库辅助 ----------
OUTFITS_FILE = os.path.join(ROOT, "runtime", "outfits.json")

def outfits_load():
    try:
        with open(OUTFITS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []

def outfits_save(items):
    os.makedirs(os.path.dirname(OUTFITS_FILE), exist_ok=True)
    with open(OUTFITS_FILE, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

def outfits_next_id(items):
    n = len(items) + 1
    while True:
        oid = "outfit_%03d" % n
        if not any(x["id"] == oid for x in items):
            return oid
        n += 1

# ---------- 人脸库辅助 ----------
FACES_FILE = os.path.join(ROOT, "runtime", "faces.json")

def faces_load():
    try:
        with open(FACES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []

def faces_save(faces):
    os.makedirs(os.path.dirname(FACES_FILE), exist_ok=True)
    with open(FACES_FILE, "w", encoding="utf-8") as f:
        json.dump(faces, f, ensure_ascii=False, indent=2)

def faces_next_id(faces):
    n = len(faces) + 1
    while True:
        fid = "face_%03d" % n
        if not any(x["id"] == fid for x in faces):
            return fid
        n += 1

# ---------- 提示词库辅助 ----------
def promptlib_load():
    if os.path.exists(PROMPTLIB_FILE):
        try:
            with open(PROMPTLIB_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []

def promptlib_save(items):
    try:
        os.makedirs(os.path.dirname(PROMPTLIB_FILE), exist_ok=True)
        with open(PROMPTLIB_FILE, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


# 运行时 JSON（faces/outfits/favorites/templates/history/promptlib）都是"整文件读改写"。
# 无锁时并发请求会丢更新（实测 12 个并发收藏只落盘 2 条），这里把相关写接口串行化。
DATA_LOCK = threading.RLock()
LOCKED_POST_PATHS = {
    "/api/favorites/toggle",
    "/api/genhistory/add", "/api/genhistory/clear",
    "/api/templates/add", "/api/templates/delete",
    "/api/faces/add", "/api/faces/upload", "/api/faces/rename",
    "/api/faces/delete", "/api/faces/use",
    "/api/outfits/add", "/api/outfits/upload", "/api/outfits/rename",
    "/api/outfits/delete", "/api/outfits/use",
    "/api/promptlib/save", "/api/promptlib/import_dir",
}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        try:
            with open(LOGFILE, "a", encoding="utf-8") as f:
                f.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))
        except OSError:
            pass

    # ---------- helpers ----------
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy_image(self, q):
        fn = q.get("filename", [""])[0]
        sub = q.get("subfolder", [""])[0]
        typ = q.get("type", ["output"])[0]
        # 优先直接读本地文件：更快，且不依赖 ComfyUI 是否繁忙
        fp = local_image_path(typ, sub, fn)
        if fp and not png_complete(fp):
            # 文件还没写完（例如正在保存）：返回 503，前端会自动重试，避免发出断图
            self.send_response(503)
            self.send_header("Retry-After", "3")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if fp:
            try:
                with open(fp, "rb") as f:
                    data = f.read()
                ext = os.path.splitext(fp)[1].lower()
                self.send_response(200)
                self.send_header("Content-Type", MIME.get(ext, "image/png"))
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return
            except OSError:
                pass
        # 回退：经 ComfyUI 代理（兼容非常规位置 / 不在本机的资源）
        params = {"filename": fn, "subfolder": sub, "type": typ}
        try:
            r = requests.get(COMFY + "/view", params=params, timeout=30)
            self.send_response(200)
            self.send_header("Content-Type", r.headers.get("Content-Type", "image/png"))
            self.send_header("Content-Length", str(len(r.content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(r.content)
        except Exception:
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()


    def _proxy_thumb(self, q):
        """生成并返回缩略图（宽300px，JPEG质量70），缓存到 runtime/thumbs/。

        源图优先直接读本地文件；读不到再回退到 ComfyUI /view（兼容非常规位置）。
        """
        from PIL import Image
        import io

        def make_thumb(image_obj):
            if image_obj.mode in ("RGBA", "P"):
                image_obj = image_obj.convert("RGB")
            w = 300
            h = max(1, int(image_obj.height * w / image_obj.width))
            image_obj = image_obj.resize((w, h), Image.LANCZOS)
            buf = io.BytesIO()
            image_obj.save(buf, "JPEG", quality=70)
            return buf.getvalue()

        fn = q.get("filename", [""])[0]
        sub = q.get("subfolder", [""])[0]
        typ = q.get("type", ["output"])[0]
        if not fn:
            self.send_response(400); self.end_headers(); return
        cache_dir = os.path.join(ROOT, "runtime", "thumbs")
        os.makedirs(cache_dir, exist_ok=True)
        # 缓存键：完整 (type, subfolder, filename) 的 SHA-1。
        # 旧实现直接拼接（subfolder 的 / 换成 _）会碰撞：subfolder "a_b"+文件 "c.png"
        # 与 subfolder "a"+文件 "b_c.png" 会得到同一个键 → 返回错图（已实测复现）。
        cache_key = hashlib.sha1(
            (typ + "/" + (sub or "") + "/" + fn).encode("utf-8")).hexdigest() + "_300.jpg"
        cache_path = os.path.join(cache_dir, cache_key)
        src_path = local_image_path(typ, sub, fn)
        if src_path and not png_complete(src_path):
            # 源文件还没写完：不生成也不缓存缩略图，让前端重试
            self.send_response(503)
            self.send_header("Retry-After", "3")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # 缓存命中且比源图新
        if os.path.exists(cache_path) and src_path:
            try:
                if os.path.getmtime(cache_path) >= os.path.getmtime(src_path):
                    with open(cache_path, "rb") as f:
                        data = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "public, max-age=86400")
                    self.end_headers()
                    self.wfile.write(data)
                    return
            except OSError:
                pass
        # 生成缩略图：优先本地文件，失败再回退 ComfyUI
        data = None
        if src_path:
            try:
                with Image.open(src_path) as img:
                    data = make_thumb(img)
            except Exception:
                data = None
        if data is None:
            try:
                r = requests.get(COMFY + "/view",
                                 params={"filename": fn, "subfolder": sub, "type": typ},
                                 timeout=30)
                with Image.open(io.BytesIO(r.content)) as img:
                    data = make_thumb(img)
            except Exception:
                self.send_response(502)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        try:
            with open(cache_path, "wb") as f:
                f.write(data)
        except Exception:
            pass
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    # ---------- GET ----------
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)

        if u.path == "/health/ready":
            self._json(200, {"service": SERVICE_ID, "ready": True})
            return

        if u.path == "/api/system":
            try:
                r = requests.get(COMFY + "/system_stats", timeout=8)
                data = r.json()
                data["online"] = True
                self._json(200, data)
            except Exception as e:
                self._json(200, {"online": False, "error": str(e)})
            return

        if u.path == "/api/history":
            pid = q.get("id", [""])[0]
            try:
                r = requests.get(COMFY + "/history/" + pid, timeout=15)
                hist = r.json()
                if pid in hist:
                    entry = hist[pid]
                    status = entry.get("status", {})
                    imgs = []
                    for _nid, out in entry.get("outputs", {}).items():
                        for im in out.get("images", []):
                            imgs.append(im)
                    self._json(200, {
                        "done": True,
                        "status_str": status.get("status_str", ""),
                        "completed": status.get("completed", False),
                        "messages": entry.get("status", {}).get("messages", []),
                        "images": imgs,
                    })
                else:
                    self._json(200, {"done": False})
            except Exception as e:
                self._json(200, {"done": False, "error": str(e)})
            return

        if u.path == "/api/view":
            self._proxy_image(q)
            return

        if u.path == "/api/prompt":
            # 返回 PNG 内嵌的全量（未截断）提示词，供图库"生成变体"使用
            fn = q.get("filename", [""])[0]
            sub = q.get("subfolder", [""])[0]
            typ = q.get("type", ["output"])[0]
            fp = local_image_path(typ, sub, fn)
            self._json(200, {"prompt": extract_prompt_from_png(fp) if fp else ""})
            return

        if u.path == "/api/thumb":
            self._proxy_thumb(q)
            return

        if u.path == "/api/queue":
            try:
                r = requests.get(COMFY + "/queue", timeout=5)
                self._json(200, r.json())
            except Exception as e:
                self._json(200, {"queue_running": [], "queue_pending": [], "error": str(e)})
            return


        if u.path == "/api/gallery/dirs":
            self._json(200, {"dirs": gallery_list_dirs()})
            return

        if u.path == "/api/gallery/list":
            sub = q.get("subfolder", [""])[0]
            page = int(q.get("page", ["1"])[0])
            size = int(q.get("size", ["48"])[0])
            search = q.get("search", [""])[0]
            only_fav = q.get("favorites", ["0"])[0] == "1"
            self._json(200, gallery_list_images(sub, page, size, search, only_fav))
            return

        if u.path == "/api/favorites/list":
            self._json(200, {"favorites": sorted(list(favorites_load()))})
            return

        if u.path == "/api/genhistory/list":
            page = int(q.get("page", ["1"])[0])
            size = int(q.get("size", ["20"])[0])
            items = history_load()
            total = len(items)
            start = (page - 1) * size
            self._json(200, {"items": items[start:start + size], "total": total, "page": page, "size": size})
            return

        if u.path == "/api/templates/list":
            self._json(200, {"items": templates_load()})
            return

        if u.path == "/api/batch/status":
            tid = q.get("id", [""])[0]
            if tid:
                t = batch_worker.get_task(tid)
                self._json(200, t if t else {"error": "not found"})
            else:
                self._json(200, {"tasks": batch_worker.list_tasks()})
            return

        if u.path == "/api/batch/external":
            self._json(200, external_batch_status())
            return

        if u.path == "/api/gen/pack":
            # 生成中心"AI 包"来源：提示词包清单与完成度
            pdir = q.get("dir", [""])[0] or DEFAULT_PACK_DIR
            self._json(200, pack_status(pdir))
            return

        if u.path == "/api/promptlib/list":
            self._json(200, {"items": promptlib_load()})
            return

        if u.path == "/api/faces/list":
            self._json(200, {"faces": faces_load()})
            return

        if u.path == "/api/outfits/list":
            self._json(200, {"outfits": outfits_load()})
            return

        self.serve_static(u.path)

    # ---------- POST ----------
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path in LOCKED_POST_PATHS:
            with DATA_LOCK:
                self._handle_post(u)
        else:
            self._handle_post(u)

    def _handle_post(self, u):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            self._json(400, {"error": "invalid JSON"})
            return

        if u.path == "/api/upload":
            # 统一上传入口，兼容两种载荷：
            #   1) {filename, data, subdir} → 存到 input/<subdir>（图生图参考图）
            #   2) {image}                  → 存到 input/characters/（锁脸参考图）
            if data.get("data"):
                filename = data.get("filename", "upload.png")
                b64data = data["data"]
                subdir = data.get("subdir", "img2img")
                try:
                    # 去掉 data:image/png;base64, 前缀
                    if "," in b64data:
                        b64data = b64data.split(",", 1)[1]
                    img_bytes = base64.b64decode(b64data)
                    save_dir = os.path.join(COMFY_INPUT, subdir)
                    os.makedirs(save_dir, exist_ok=True)
                    # 安全文件名
                    safe_name = "".join(c for c in filename if c.isalnum() or c in "._-")
                    if not safe_name:
                        safe_name = "upload.png"
                    with open(os.path.join(save_dir, safe_name), "wb") as f:
                        f.write(img_bytes)
                    rel_path = subdir + "/" + safe_name
                    self._json(200, {"path": rel_path, "image": rel_path,
                                     "filename": safe_name, "size": len(img_bytes)})
                except Exception as e:
                    self._json(500, {"error": str(e)})
                return
            uri = data.get("image", "")
            if not uri:
                self._json(400, {"error": "missing data"})
                return
            if "," in uri:
                uri = uri.split(",", 1)[1]
            try:
                blob = base64.b64decode(uri)
            except Exception:
                self._json(400, {"error": "bad base64"})
                return
            d = os.path.join(COMFY_INPUT, CHARACTER_SUBDIR)
            try:
                os.makedirs(d, exist_ok=True)
                name = "char_%d.png" % int(time.time() * 1000)
                with open(os.path.join(d, name), "wb") as f:
                    f.write(blob)
            except OSError as e:
                self._json(200, {"error": str(e)})
                return
            self._json(200, {"ok": True, "image": CHARACTER_SUBDIR + "/" + name,
                             "bytes": len(blob)})
            return

        if u.path == "/api/generate":
            prompt = build_prompt(data)
            try:
                r = requests.post(COMFY + "/prompt",
                                  json={"prompt": prompt, "client_id": "nsfw-studio"},
                                  timeout=30)
                self._json(r.status_code, r.json())
            except requests.exceptions.ConnectionError:
                self._json(200, {"error": "无法连接 ComfyUI（127.0.0.1:8188），请先启动它。"})
            except Exception as e:
                self._json(200, {"error": str(e)})
            return



        if u.path == "/api/outfits/add":
            fn = data.get("filename", "")
            sub = data.get("subfolder", "")
            name = data.get("name", "")
            tags = data.get("tags", [])
            if not fn:
                self._json(400, {"error": "缺少 filename"}); return
            src_fp = os.path.join(COMFY_OUTPUT, sub, fn) if sub else os.path.join(COMFY_OUTPUT, fn)
            if not os.path.isfile(src_fp):
                self._json(400, {"error": "源文件不存在"}); return
            items = outfits_load()
            oid = outfits_next_id(items)
            import shutil
            dst_name = oid + ".png"
            dst_dir = os.path.join(COMFY_INPUT, OUTFIT_SUBDIR)
            os.makedirs(dst_dir, exist_ok=True)
            shutil.copy2(src_fp, os.path.join(dst_dir, dst_name))
            items.insert(0, {
                "id": oid, "filename": OUTFIT_SUBDIR + "/" + dst_name,
                "name": name or oid, "tags": tags,
                "created_at": time.time(), "use_count": 0, "source": "gallery",
            })
            outfits_save(items)
            self._json(200, {"ok": True, "outfit": items[0]})
            return

        if u.path == "/api/outfits/upload":
            image_b64 = data.get("image", "")
            name = data.get("name", "")
            tags = data.get("tags", [])
            if "," in image_b64:
                image_b64 = image_b64.split(",", 1)[1]
            try:
                blob = base64.b64decode(image_b64)
            except Exception:
                self._json(400, {"error": "bad base64"}); return
            items = outfits_load()
            oid = outfits_next_id(items)
            dst_name = oid + ".png"
            dst_dir = os.path.join(COMFY_INPUT, OUTFIT_SUBDIR)
            os.makedirs(dst_dir, exist_ok=True)
            with open(os.path.join(dst_dir, dst_name), "wb") as f:
                f.write(blob)
            items.insert(0, {
                "id": oid, "filename": OUTFIT_SUBDIR + "/" + dst_name,
                "name": name or oid, "tags": tags,
                "created_at": time.time(), "use_count": 0, "source": "upload",
            })
            outfits_save(items)
            self._json(200, {"ok": True, "outfit": items[0]})
            return

        if u.path == "/api/outfits/rename":
            oid = data.get("id", "")
            new_name = data.get("name", "")
            new_tags = data.get("tags", None)
            items = outfits_load()
            for it in items:
                if it["id"] == oid:
                    if new_name: it["name"] = new_name
                    if new_tags is not None: it["tags"] = new_tags
                    outfits_save(items)
                    self._json(200, {"ok": True}); return
            self._json(404, {"error": "not found"}); return

        if u.path == "/api/outfits/delete":
            oid = data.get("id", "")
            items = outfits_load()
            for i, it in enumerate(items):
                if it["id"] == oid:
                    try:
                        fp = os.path.join(COMFY_INPUT, it["filename"].replace("/", os.sep))
                        if os.path.isfile(fp): os.remove(fp)
                    except Exception: pass
                    items.pop(i)
                    outfits_save(items)
                    self._json(200, {"ok": True}); return
            self._json(404, {"error": "not found"}); return

        if u.path == "/api/outfits/use":
            oid = data.get("id", "")
            items = outfits_load()
            for it in items:
                if it["id"] == oid:
                    it["use_count"] = it.get("use_count", 0) + 1
                    outfits_save(items)
                    self._json(200, {"ok": True}); return
            self._json(404, {"error": "not found"}); return

        if u.path == "/api/faces/add":
            # 从 output 目录复制一张图到 characters 目录
            fn = data.get("filename", "")
            sub = data.get("subfolder", "")
            name = data.get("name", "")
            tags = data.get("tags", [])
            if not fn:
                self._json(400, {"error": "缺少 filename"}); return
            src_fp = os.path.join(COMFY_OUTPUT, sub, fn) if sub else os.path.join(COMFY_OUTPUT, fn)
            if not os.path.isfile(src_fp):
                self._json(400, {"error": "源文件不存在: " + src_fp}); return
            faces = faces_load()
            fid = faces_next_id(faces)
            import shutil
            dst_name = fid + ".png"
            dst_dir = os.path.join(COMFY_INPUT, CHARACTER_SUBDIR)
            os.makedirs(dst_dir, exist_ok=True)
            shutil.copy2(src_fp, os.path.join(dst_dir, dst_name))
            faces.insert(0, {
                "id": fid,
                "filename": CHARACTER_SUBDIR + "/" + dst_name,
                "name": name or fid,
                "tags": tags,
                "created_at": time.time(),
                "use_count": 0,
                "source": "gallery",
            })
            faces_save(faces)
            self._json(200, {"ok": True, "face": faces[0]})
            return

        if u.path == "/api/faces/upload":
            # 直接上传 base64 图片
            image_b64 = data.get("image", "")
            name = data.get("name", "")
            tags = data.get("tags", [])
            if "," in image_b64:
                image_b64 = image_b64.split(",", 1)[1]
            try:
                blob = base64.b64decode(image_b64)
            except Exception:
                self._json(400, {"error": "bad base64"}); return
            faces = faces_load()
            fid = faces_next_id(faces)
            dst_name = fid + ".png"
            dst_dir = os.path.join(COMFY_INPUT, CHARACTER_SUBDIR)
            os.makedirs(dst_dir, exist_ok=True)
            with open(os.path.join(dst_dir, dst_name), "wb") as f:
                f.write(blob)
            faces.insert(0, {
                "id": fid,
                "filename": CHARACTER_SUBDIR + "/" + dst_name,
                "name": name or fid,
                "tags": tags,
                "created_at": time.time(),
                "use_count": 0,
                "source": "upload",
            })
            faces_save(faces)
            self._json(200, {"ok": True, "face": faces[0]})
            return

        if u.path == "/api/faces/rename":
            fid = data.get("id", "")
            new_name = data.get("name", "")
            new_tags = data.get("tags", None)
            faces = faces_load()
            for f_item in faces:
                if f_item["id"] == fid:
                    if new_name:
                        f_item["name"] = new_name
                    if new_tags is not None:
                        f_item["tags"] = new_tags
                    faces_save(faces)
                    self._json(200, {"ok": True}); return
            self._json(404, {"error": "face not found"}); return

        if u.path == "/api/faces/delete":
            fid = data.get("id", "")
            faces = faces_load()
            for i, f_item in enumerate(faces):
                if f_item["id"] == fid:
                    # 删除图片文件
                    try:
                        fp = os.path.join(COMFY_INPUT, f_item["filename"].replace("/", os.sep))
                        if os.path.isfile(fp):
                            os.remove(fp)
                    except Exception:
                        pass
                    faces.pop(i)
                    faces_save(faces)
                    self._json(200, {"ok": True}); return
            self._json(404, {"error": "face not found"}); return

        if u.path == "/api/faces/use":
            # 使用一次：use_count +1
            fid = data.get("id", "")
            faces = faces_load()
            for f_item in faces:
                if f_item["id"] == fid:
                    f_item["use_count"] = f_item.get("use_count", 0) + 1
                    faces_save(faces)
                    self._json(200, {"ok": True}); return
            self._json(404, {"error": "face not found"}); return

        if u.path == "/api/upscale":
            im = {"filename": data.get("filename", ""),
                  "subfolder": data.get("subfolder", ""),
                  "type": data.get("type", "output")}
            if not im["filename"]:
                self._json(400, {"error": "missing filename"})
                return
            prompt = build_upscale_prompt(im)
            try:
                r = requests.post(COMFY + "/prompt",
                                  json={"prompt": prompt, "client_id": "nsfw-studio"},
                                  timeout=30)
                self._json(r.status_code, r.json())
            except requests.exceptions.ConnectionError:
                self._json(200, {"error": "无法连接 ComfyUI（127.0.0.1:8188），请先启动它。"})
            except Exception as e:
                self._json(200, {"error": str(e)})
            return

        if u.path == "/api/interrupt":
            try:
                requests.post(COMFY + "/interrupt", timeout=10)
                self._json(200, {"ok": True})
            except Exception as e:
                self._json(200, {"error": str(e)})
            return


        if u.path == "/api/gallery/delete":
            imgs = data.get("images", [])
            self._json(200, gallery_delete(imgs))
            return

        if u.path == "/api/favorites/toggle":
            key = data.get("key", "")
            if not key:
                self._json(400, {"error": "missing key"})
                return
            is_fav = favorites_toggle(key)
            self._json(200, {"favorite": is_fav, "key": key})
            return

        if u.path == "/api/genhistory/add":
            record = {
                "positive": data.get("positive", ""),
                "negative": data.get("negative", ""),
                "seed": data.get("seed"),
                "width": data.get("width"),
                "height": data.get("height"),
                "steps": data.get("steps"),
                "cfg": data.get("cfg"),
                "images": data.get("images", []),
                "lock_image": data.get("lock_image"),
                "outfit_image": data.get("outfit_image"),
            }
            rec = history_add(record)
            self._json(200, rec)
            return

        if u.path == "/api/genhistory/clear":
            history_clear()
            self._json(200, {"ok": True})
            return

        if u.path == "/api/templates/add":
            tpl = {
                "name": data.get("name", "未命名模板"),
                "positive": data.get("positive", ""),
                "negative": data.get("negative", ""),
                "width": data.get("width"),
                "height": data.get("height"),
                "steps": data.get("steps"),
                "cfg": data.get("cfg"),
                "count": data.get("count"),   # 模板默认张数（生成中心用；控制台不传则为 None）
            }
            rec = templates_add(tpl)
            self._json(200, rec)
            return

        if u.path == "/api/templates/delete":
            tid = data.get("id")
            if tid:
                templates_delete(int(tid))
            self._json(200, {"ok": True})
            return

        if u.path == "/api/gallery/upscale":
            im = {"filename": data.get("filename", ""),
                  "subfolder": data.get("subfolder", ""),
                  "type": data.get("type", "output")}
            if not im["filename"]:
                self._json(400, {"error": "missing filename"})
                return
            prompt = build_upscale_prompt(im)
            try:
                r = requests.post(COMFY + "/prompt",
                                  json={"prompt": prompt, "client_id": "nsfw-studio"},
                                  timeout=30)
                self._json(r.status_code, r.json())
            except requests.exceptions.ConnectionError:
                self._json(200, {"error": "无法连接 ComfyUI"})
            except Exception as e:
                self._json(200, {"error": str(e)})
            return

        if u.path == "/api/batch/create":
            items = data.get("items", [])
            if not items:
                self._json(400, {"error": "items empty"})
                return
            task = batch_worker.create_task(
                items=items,
                width=int(data.get("width", 832)),
                height=int(data.get("height", 1216)),
                steps=int(data.get("steps", 25)),
                cfg=float(data.get("cfg", 1.0)),
                # 默认前缀给独立目录，避免内部批量与控制台单张混在同一目录
                prefix=data.get("prefix") or "nsfw-studio/batch",
                name=data.get("name", ""),
                lock_image=data.get("lock_image"),
            )
            self._json(200, {"id": task["id"], "total": task["total"]})
            return

        if u.path == "/api/batch/cancel":
            tid = data.get("id", "")
            batch_worker.cancel_task(tid)
            self._json(200, {"ok": True})
            return

        if u.path == "/api/batch/delete":
            tid = data.get("id", "")
            t = batch_worker.get_task(tid)
            if t and t.get("status") in ("pending", "running"):
                # 运行中/排队中的任务被删除会导致状态文件"复活"，必须先停止
                self._json(400, {"error": "任务正在排队/运行中，请先「停止」再删除"})
                return
            batch_worker.delete_task(tid)
            self._json(200, {"ok": True})
            return

        if u.path == "/api/batch/external/start":
            try:
                count_per = int(data.get("count_per", 16))
                start_idx = int(data.get("start_idx", 1))
            except (TypeError, ValueError):
                self._json(200, {"ok": False, "error": "参数必须是整数"})
                return
            if not (1 <= count_per <= 64):
                self._json(200, {"ok": False, "error": "每段张数需在 1-64 之间"})
                return
            if start_idx < 1:
                self._json(200, {"ok": False, "error": "起始段需不小于 1"})
                return
            self._json(200, external_batch_start(count_per, start_idx))
            return

        if u.path == "/api/batch/external/stop":
            self._json(200, external_batch_stop())
            return

        if u.path == "/api/gen/submit":
            # 生成中心：散图来源（手写 / 模板 / 库）统一提交
            # 统一编号：每条分配全局 ID（1000 起），种子 = 180000 + ID*100，
            # 输出目录 <分类>/<ID>_<名称>/，文件名 <ID>_第<NN>张_s<种子>_...
            source = data.get("source", "manual")
            cate_default = {"manual": "手动", "keyword": "拼接", "template": "模板", "library": "库"}.get(source, "手动")
            items_in = data.get("items") or []
            if not items_in:
                self._json(200, {"ok": False, "error": "没有可生成的提示词"})
                return
            try:
                width = int(data.get("width", 832))
                height = int(data.get("height", 1216))
                steps = int(data.get("steps", 25))
                cfg = float(data.get("cfg", 1.0))
            except (TypeError, ValueError):
                self._json(200, {"ok": False, "error": "参数必须是数字"})
                return
            if not (64 <= width <= 4096 and 64 <= height <= 4096 and 1 <= steps <= 100):
                self._json(200, {"ok": False, "error": "尺寸或步数超出范围"})
                return
            clean = []
            for it in items_in:
                pos = (it.get("positive") or "").strip()
                if not pos:
                    self._json(200, {"ok": False, "error": "存在空的正面提示词"})
                    return
                try:
                    cnt = int(it.get("count", 1) or 1)
                except (TypeError, ValueError):
                    cnt = 1
                if not (1 <= cnt <= 200):
                    self._json(200, {"ok": False, "error": "张数需在 1-200 之间"})
                    return
                clean.append({
                    "label": (it.get("name") or "").strip() or "未命名",
                    "name": (it.get("name") or "").strip(),
                    "category": (it.get("category") or "").strip() or cate_default,
                    "positive": pos,
                    "negative": (it.get("negative") or "").strip(),
                    "count": cnt,
                })
            ids = gene_ids_alloc(len(clean))
            default_name = "生成_" + time.strftime("%m%d_%H%M")
            task_items = []
            for c, eid in zip(clean, ids):
                if not c["name"]:
                    c["name"] = default_name
                    c["label"] = default_name
                nm = _safe_name(c["name"], "未命名")
                cat = _safe_name(c["category"], "手动")
                task_items.append({
                    "label": c["label"], "positive": c["positive"], "negative": c["negative"],
                    "count": c["count"], "seed": 180000 + eid * 100,
                    "entry_id": eid, "out_dir": "%s/%d_%s" % (cat, eid, nm),
                })
            # 单条任务直接以条目名命名（历史列表一眼可认）；多条任务用来源命名
            single = task_items[0]["label"] if len(task_items) == 1 else None
            # 参考图（锁脸 / 服饰）：相对 ComfyUI input 的路径（如 characters/face_002.png）
            lock_image = (data.get("lock_image") or "").strip() or None
            outfit_image = (data.get("outfit_image") or "").strip() or None
            task = batch_worker.create_task(
                items=task_items, width=width, height=height,
                steps=steps, cfg=cfg, prefix="nsfw-studio/batch",
                name=data.get("task_name") or single or ("生成中心 · %s" % source),
                lock_image=lock_image, outfit_image=outfit_image)
            self._json(200, {
                "ok": True, "id": task["id"], "total": task["total"],
                "entries": [{"id": t["entry_id"], "dir": t["out_dir"]} for t in task_items],
            })
            return

        if u.path == "/api/gen/lookup":
            # 生成中心：按提示词文本（归一化空白后精确匹配）查找"已生成的图片"。
            # 数据源：生成历史（控制台单次生成）+ 全部内部批量任务（含生成中心/包任务）。
            text = (data.get("text") or "").strip()
            if not text:
                self._json(200, {"count": 0, "images": []})
                return
            norm = re.sub(r"\s+", "", text)
            images, seen = [], set()

            def _add(im):
                if not isinstance(im, dict) or not im.get("filename"):
                    return
                key = (im.get("subfolder") or "") + "/" + im["filename"]
                if key in seen:
                    return
                seen.add(key)
                images.append({"filename": im["filename"],
                               "subfolder": im.get("subfolder", ""),
                               "type": im.get("type", "output")})

            for rec in history_load():
                if isinstance(rec, dict) and re.sub(r"\s+", "", rec.get("positive") or "") == norm:
                    for im in (rec.get("images") or []):
                        _add(im)
            if os.path.isdir(batch_worker.STATE_DIR):
                for fn in os.listdir(batch_worker.STATE_DIR):
                    if not fn.endswith(".json"):
                        continue
                    try:
                        with open(os.path.join(batch_worker.STATE_DIR, fn), "r", encoding="utf-8") as f:
                            t = json.load(f)
                    except Exception:
                        continue
                    for it in (t.get("items") or []):
                        if isinstance(it, dict) and re.sub(r"\s+", "", it.get("positive") or "") == norm:
                            for im in (it.get("images") or []):
                                _add(im)
            self._json(200, {"count": len(images), "images": images[:60]})
            return

        if u.path == "/api/gen/pack/submit":
            # 生成中心"AI 包"来源：把提示词包的选中条目提交内部批量。
            # 命名/种子与外部千问脚本完全一致（<ID>_第NN张_s种子），两个引擎可互相续跑。
            pdir = data.get("dir") or DEFAULT_PACK_DIR
            ids_sel = data.get("ids") or []
            try:
                sel = set(int(x) for x in ids_sel)
            except (TypeError, ValueError):
                self._json(200, {"ok": False, "error": "ids 必须是数字列表"})
                return
            if not sel:
                self._json(200, {"ok": False, "error": "请先勾选要生成的条目"})
                return
            mp = os.path.join(pdir, "manifest.json")
            if not os.path.isfile(mp):
                self._json(200, {"ok": False, "error": "包目录缺少 manifest.json"})
                return
            try:
                with open(mp, "r", encoding="utf-8-sig") as f:
                    man = json.load(f)
            except Exception as e:
                self._json(200, {"ok": False, "error": "manifest 读取失败：%s" % e})
                return
            params = man.get("params", {}) if isinstance(man.get("params"), dict) else {}
            try:
                width = int(data.get("width") or params.get("width") or 832)
                height = int(data.get("height") or params.get("height") or 1216)
                steps = int(data.get("steps") or params.get("steps") or 25)
                cfg = float(data.get("cfg") if data.get("cfg") is not None else (params.get("cfg") or 1.0))
                count_per = int(data.get("count_per") or params.get("count_per") or 16)
            except (TypeError, ValueError):
                self._json(200, {"ok": False, "error": "参数必须是数字"})
                return
            count_per = max(1, min(200, count_per))
            batch_dir = os.path.basename(BATCH_OUTPUT)  # "千问批量"
            task_items, missing = [], []
            for it in man.get("items", []):
                try:
                    eid = int(it.get("id", 0) or 0)
                except (TypeError, ValueError):
                    continue
                if eid not in sel or not it.get("enabled", True):
                    continue
                fp = os.path.join(pdir, it.get("file", ""))
                if not os.path.isfile(fp):
                    missing.append(it.get("file", ""))
                    continue
                try:
                    with open(fp, "r", encoding="utf-8-sig") as f:
                        pos, neg = parse_prompt_txt(f.read())
                except OSError:
                    missing.append(it.get("file", ""))
                    continue
                if not pos:
                    missing.append(it.get("file", ""))
                    continue
                try:
                    cnt = int(it.get("count") or count_per)
                except (TypeError, ValueError):
                    cnt = count_per
                stem = os.path.splitext(it.get("file", ""))[0]
                task_items.append({
                    "label": it.get("title") or stem, "positive": pos, "negative": neg,
                    "count": max(1, min(200, cnt)), "seed": 180000 + eid * 100,
                    "entry_id": eid, "out_dir": "%s/%s" % (batch_dir, stem),
                })
            if not task_items:
                self._json(200, {"ok": False, "error": "没有可提交的条目（全部缺失或未勾选）"})
                return
            task = batch_worker.create_task(
                items=task_items, width=width, height=height,
                steps=steps, cfg=cfg, prefix=batch_dir,
                name=data.get("task_name") or ("AI 包 · %s" % (man.get("name") or os.path.basename(pdir))))
            self._json(200, {"ok": True, "id": task["id"], "total": task["total"],
                             "submitted": len(task_items), "missing": missing})
            return

        if u.path == "/api/promptlib/save":
            items = data.get("items", [])
            ok = promptlib_save(items)
            self._json(200, {"ok": ok})
            return

        if u.path == "/api/promptlib/import_dir":
            d = data.get("dir", "")
            imported = []
            if d and os.path.isdir(d):
                for fn in sorted(os.listdir(d)):
                    if fn.endswith(".txt"):
                        try:
                            with open(os.path.join(d, fn), "r", encoding="utf-8-sig") as tf:
                                pos, neg = parse_prompt_txt(tf.read())
                            imported.append({
                                "id": fn.replace(".txt", ""),
                                "name": fn.replace(".txt", ""),
                                "positive": pos,
                                "negative": neg,
                            })
                        except Exception:
                            pass
            # 合并到现有提示词库并保存
            existing = promptlib_load()
            existing_ids = set(x.get("id", "") for x in existing)
            for it in imported:
                if it["id"] not in existing_ids:
                    existing.append(it)
                    existing_ids.add(it["id"])
            promptlib_save(existing)
            self._json(200, {"imported": len(imported), "items": imported, "total": len(existing)})
            return

        self._json(404, {"error": "not found"})

    # ---------- static ----------
    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = urllib.parse.unquote(path.lstrip("/"))
        fp = os.path.normpath(os.path.join(STATIC, rel))
        if not fp.startswith(STATIC) or not os.path.isfile(fp):
            body = b"not found"
            self.send_response(404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        ext = os.path.splitext(fp)[1].lower()
        with open(fp, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        # 前端改动要求“F5 即生效”，禁用启发式缓存
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    # 默认积压队列仅 5：页面一次并发加载十几个静态文件时会被拒（ERR_CONNECTION_REFUSED）
    request_queue_size = 128


def create_stop_event():
    """创建 ControlHub 协作停止事件（manual-reset、初始未触发、默认 ACL、句柄不继承）。

    同名事件已存在时拒绝启动（单实例）。返回事件句柄。
    """
    name = "Local\\AIHome.TaskStop." + hashlib.sha256(TASK_PATH.casefold().encode()).hexdigest()
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateEventW.restype = wintypes.HANDLE
    kernel32.CreateEventW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    handle = kernel32.CreateEventW(None, 1, 0, name)
    if not handle:
        print("创建停止事件失败，错误码 %d" % ctypes.get_last_error())
        return None
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        print("检测到已存在的服务实例（停止事件已存在），拒绝重复启动。")
        kernel32.CloseHandle(handle)
        return None
    return handle


def main():
    stop_handle = create_stop_event()
    if stop_handle is None:
        sys.exit(1)

    load_prompt_cache()
    threading.Thread(target=_prompt_cache_flusher, name="prompt-cache-flush", daemon=True).start()

    srv = ThreadingServer(("127.0.0.1", PORT), Handler)
    url = "http://127.0.0.1:%d" % PORT

    def watch_stop():
        # INFINITE = -1；事件被平台触发后停止 HTTP 循环
        ctypes.windll.kernel32.WaitForSingleObject(stop_handle, 0xFFFFFFFF)
        srv.shutdown()

    t = threading.Thread(target=watch_stop, name="taskstop-watch", daemon=True)
    t.start()

    print("NSFW Studio 已启动：%s" % url)
    if "--no-browser" not in sys.argv:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            srv.server_close()
        except Exception:
            pass
        flush_prompt_cache()
        ctypes.windll.kernel32.CloseHandle(stop_handle)
    sys.exit(0)


def _pid_alive(pid):
    """检查 PID 是否存活（OpenProcess + WaitForSingleObject，不发送任何信号）。"""
    try:
        kernel32 = ctypes.windll.kernel32
        kernel32.OpenProcess.restype = wintypes.HANDLE
        h = kernel32.OpenProcess(0x00100000, False, int(pid))  # PROCESS_SYNCHRONIZE
        if not h:
            return False
        try:
            return kernel32.WaitForSingleObject(h, 0) == 0x102  # WAIT_TIMEOUT=仍存活
        finally:
            kernel32.CloseHandle(h)
    except Exception:
        return False


def _external_run_marker():
    """读运行标记（脚本或启动接口写入，含 pid）。

    用 utf-8-sig 读取：容忍外部工具写出的带 BOM 文件（BOM 会使 json 解析失败，
    导致标记被当作不存在 → 可能放行重复启动）。
    """
    try:
        with open(EXT_BATCH_MARKER, "r", encoding="utf-8-sig") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else None
    except Exception:
        return None


def _marker_fresh(marker):
    """运行标记心跳是否新鲜：取 ts 字段（ISO 时间），缺失时回退文件 mtime。

    脚本在提交前/等待中每 10 秒左右心跳一次；脚本被强杀或机器重启后
    心跳停止，超过 EXT_BATCH_HEARTBEAT_MAX_AGE 即视为陈旧，不再据此判"运行中"。
    """
    age = None
    ts = marker.get("ts") if isinstance(marker, dict) else None
    if ts:
        try:
            from datetime import datetime as _dt
            age = (time.time() - _dt.fromisoformat(ts).timestamp())
        except Exception:
            age = None
    if age is None:
        try:
            age = time.time() - os.path.getmtime(EXT_BATCH_MARKER)
        except OSError:
            age = None
    return age is not None and age < EXT_BATCH_HEARTBEAT_MAX_AGE


def external_batch_status():
    """外部批量脚本状态：ComfyUI 队列 + 运行标记 pid + 最新日志解析。

    运行判定不依赖"日志 3 分钟新鲜度"（停止后会在 3 分钟内误报在跑），改为：
    队列里有 client_id=qwen-batch20-v2 的任务，或运行标记里的 pid 仍存活。
    """
    result = {"running": False, "total": 800, "done": 0, "current_segment": "",
              "current_img": 0, "segment_total": 16, "last_image": "", "last_time": "",
              "log_file": "", "error": None,
              "stop_flag": os.path.isfile(EXT_BATCH_STOP_FLAG),
              "can_start": os.path.isfile(EXT_BATCH_SCRIPT) and os.path.isfile(EXT_BATCH_PYTHON),
              "pid": None, "started": ""}
    try:
        # 1) ComfyUI 队列里有没有它的任务（client_id 固定）
        try:
            rq = requests.get(COMFY + "/queue", timeout=5).json()
            for item in (rq.get("queue_running", []) + rq.get("queue_pending", [])):
                try:
                    # 队列项结构：[priority, prompt_id, prompt, extra_data, outputs_to_execute]，
                    # client_id 在 extra_data（索引 3），不是索引 2
                    if item[3].get("client_id") == EXT_BATCH_CLIENT:
                        result["running"] = True
                        break
                except Exception:
                    pass
        except Exception:
            pass

        # 2) 运行标记：pid 存活 + 心跳新鲜（覆盖预检/排队间隙；脚本被强杀/重启后
        #    心跳停止 → 不误报"运行中"，即使 pid 恰好被新进程复用）
        marker = _external_run_marker()
        if marker and marker.get("pid") and _pid_alive(marker["pid"]):
            if _marker_fresh(marker):
                result["running"] = True
                result["pid"] = int(marker["pid"])
                result["started"] = str(marker.get("started", ""))
            else:
                result["stale_marker"] = True
        elif marker:
            result["stale_marker"] = True   # 进程已死，标记残留

        # 陈旧标记清理：仅在确认未运行（队列里也没有它的任务）时执行
        if marker and not result["running"]:
            try:
                os.remove(EXT_BATCH_MARKER)
            except OSError:
                pass

        # 找最新日志（排除启动器 stdout 日志）
        if not os.path.isdir(BATCH_LOGDIR):
            result["error"] = "日志目录不存在"
            return result
        logs = sorted([f for f in os.listdir(BATCH_LOGDIR)
                       if f.startswith("qwen_batch_") and f.endswith(".log")
                       and "launcher" not in f],
                      key=lambda f: os.path.getmtime(os.path.join(BATCH_LOGDIR, f)), reverse=True)
        if not logs:
            result["error"] = "无日志文件"
            return result
        log_path = os.path.join(BATCH_LOGDIR, logs[0])
        result["log_file"] = logs[0]
        result["log_mtime"] = os.path.getmtime(log_path)

        # 读最后 100 行解析
        with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
            lines = f.readlines()[-100:]

        import re
        for line in lines:
            # 当前段：[14/50] L3半裸_04_浴室镜前
            m = re.match(r"\[(\d+)/\d+\]\s+(.+?)\s+pos=", line)
            if m:
                result["current_segment"] = m.group(2).strip()
                result["current_seg_num"] = int(m.group(1))
            # 完成：OK  #10 seed=181209  70.0s  [208/800]
            m = re.search(r"OK\s+#(\d+)\s+seed=\d+\s+([\d.]+)s\s+\[(\d+)/\d+\]", line)
            if m:
                result["current_img"] = int(m.group(1))
                result["done"] = int(m.group(3))
                result["last_secs"] = float(m.group(2))  # 供前端按实测速度估算剩余时间
                result["last_image"] = line.split("'")[-2] if "'" in line else ""
                result["last_time"] = line[1:9] if line.startswith("[") else ""
            # 跳过：SKIP #08
            m = re.search(r"SKIP\s+#(\d+)", line)
            if m:
                result["current_img"] = int(m.group(1))

        # 统计输出目录实际图片数
        if os.path.isdir(BATCH_OUTPUT):
            actual = 0
            for root, _dirs, files in os.walk(BATCH_OUTPUT):
                actual += sum(1 for f in files if f.lower().endswith(".png"))
            result["actual_images"] = actual
            if actual > result["done"]:
                result["done"] = actual

    except Exception as e:
        result["error"] = str(e)
    return result


def external_batch_stop():
    """优雅停止：写停止标志文件，脚本在下一张开始前退出（不打断当前张）。"""
    st = external_batch_status()
    if not st.get("running"):
        return {"ok": False, "error": "外部脚本未在运行"}
    try:
        os.makedirs(EXT_BATCH_FLAGS_DIR, exist_ok=True)
        with open(EXT_BATCH_STOP_FLAG, "w", encoding="utf-8") as f:
            f.write("stop requested at %s\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
    except OSError as e:
        return {"ok": False, "error": "写入停止标志失败：%s" % e}
    return {"ok": True, "message": "已请求优雅停止：当前这张生完即退出，已生成图片保留，可断点续跑"}


def external_batch_start(count_per, start_idx):
    """用 comfyui venv python 以分离进程启动外部批量脚本（单实例保护）。"""
    if not os.path.isfile(EXT_BATCH_SCRIPT):
        return {"ok": False, "error": "脚本不存在：%s" % EXT_BATCH_SCRIPT}
    if not os.path.isfile(EXT_BATCH_PYTHON):
        return {"ok": False, "error": "venv python 不存在：%s" % EXT_BATCH_PYTHON}
    st = external_batch_status()
    if st.get("running"):
        return {"ok": False, "error": "外部脚本已在运行（单实例保护）"}
    # 清理上次遗留的停止标志，避免刚启动就被停
    try:
        if os.path.isfile(EXT_BATCH_STOP_FLAG):
            os.remove(EXT_BATCH_STOP_FLAG)
    except OSError:
        pass
    flags = 0x00000200 | 0x00000008  # CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS
    try:
        os.makedirs(os.path.dirname(EXT_BATCH_LAUNCH_LOG), exist_ok=True)
        out = open(EXT_BATCH_LAUNCH_LOG, "ab")
    except OSError:
        out = subprocess.DEVNULL
    try:
        proc = subprocess.Popen(
            [EXT_BATCH_PYTHON, "-u", EXT_BATCH_SCRIPT, str(count_per), str(start_idx)],
            cwd=COMFY_PROJECT, stdin=subprocess.DEVNULL,
            stdout=out, stderr=subprocess.STDOUT,
            creationflags=flags, close_fds=True)
    except Exception as e:
        return {"ok": False, "error": "启动失败：%s" % e}
    finally:
        if hasattr(out, "close"):
            try:
                out.close()
            except Exception:
                pass
    # 立即写运行标记（Popen pid 即脚本本体），消除启动窗口内的单实例误判
    try:
        os.makedirs(EXT_BATCH_FLAGS_DIR, exist_ok=True)
        with open(EXT_BATCH_MARKER, "w", encoding="utf-8") as f:
            json.dump({"pid": proc.pid,
                       "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
                       "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                       "count_per": count_per, "start_idx": start_idx},
                      f, ensure_ascii=False)
    except OSError:
        pass
    return {"ok": True, "pid": proc.pid,
            "message": "已启动：每段 %d 张，从第 %d 段开始；已生成的图自动跳过（断点续跑）" % (count_per, start_idx)}


if __name__ == "__main__":
    main()
