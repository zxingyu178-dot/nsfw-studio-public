# -*- coding: utf-8 -*-
"""NSFW Studio 批量生图引擎。

后台线程串行提交 ComfyUI，支持：
  - 多组提示词，每组多张
  - 断点续跑（已落盘的图片自动跳过）
  - 取消（协作中断 ComfyUI）
  - 状态持久化到 runtime/batch/<task_id>.json
  - 单 worker，任务按创建顺序排队
"""
import json
import os
import time
import threading
import requests
import uuid

COMFY = "http://127.0.0.1:8188"
ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(ROOT, "runtime", "batch")
COMFY_OUTPUT = os.path.normpath(os.path.join(ROOT, "..", "comfyui", "app", "output"))
os.makedirs(STATE_DIR, exist_ok=True)

UNET = "qwen-image-2.1-UC-Q4_0.gguf"
CLIP = "qwen3vl_8b_w4a8.safetensors"
VAE = "qwen_image_2.1_vae_bf16.safetensors"
CLIENT_ID = "nsfw-batch"  # 提交给 ComfyUI 的 client_id，用于区分本引擎与其他客户端（如外部批量脚本）

# ---------- 内存中的任务表 ----------
_tasks = {}
_lock = threading.Lock()
_worker = None
_stop = threading.Event()


# ---------- 工作流构建（与 server.py 一致） ----------
def build_prompt(p):
    w = int(p["width"])
    h = int(p["height"])
    lock = p.get("lock_image")
    outfit = p.get("outfit_image")
    enc_inputs = {
        "clip": ["11", 0],
        "prompt": p["positive"],
        "negative_prompt": p.get("negative", ""),
        "resolution": 1024,
    }
    prompt = {
        "10": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": UNET}},
        "11": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "qwen_image", "device": "cpu"}},
        "12": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "22": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "23": {"class_type": "KSampler", "inputs": {
            "model": ["10", 0], "seed": int(p["seed"]), "steps": int(p["steps"]),
            "cfg": float(p["cfg"]), "sampler_name": "euler", "scheduler": "simple",
            "positive": ["13", 0], "negative": ["13", 1], "latent_image": ["22", 0], "denoise": 1.0}},
        "24": {"class_type": "VAEDecode", "inputs": {"samples": ["23", 0], "vae": ["12", 0]}},
        "25": {"class_type": "SaveImage", "inputs": {"images": ["24", 0],
               # 文件名带种子（_s<seed>_）：断点续跑靠它识别"这张已经生成过"，
               # 与外部千问批量脚本的命名约定一致
               "filename_prefix": "%s_s%d" % (p.get("prefix", "nsfw-studio/batch"), int(p["seed"]))}},
    }
    # 锁脸 / 服饰参考图：LoadImage 接入 TextEncodeQwenImage21 的 autogrow 组。
    # API 键名必须是 "images.image_N"（与 server.py 控制台链路一致，勿改成嵌套结构）。
    if lock:
        prompt["30"] = {"class_type": "LoadImage", "inputs": {"image": lock}}
        enc_inputs["images.image_1"] = ["30", 0]
        enc_inputs["vae"] = ["12", 0]
    if outfit:
        prompt["31"] = {"class_type": "LoadImage", "inputs": {"image": outfit}}
        enc_inputs["images.image_2"] = ["31", 0]
        enc_inputs["vae"] = ["12", 0]
    prompt["13"] = {"class_type": "TextEncodeQwenImage21", "inputs": enc_inputs}
    return prompt


# ---------- 持久化 ----------
def _path(tid):
    return os.path.join(STATE_DIR, tid + ".json")

def _load(tid):
    p = _path(tid)
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None

def _save(task):
    try:
        with open(_path(task["id"]), "w", encoding="utf-8") as f:
            json.dump(task, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


# ---------- 断点续跑：检查图片是否已落盘 ----------
def _image_exists(prefix, seed):
    """断点续跑：按 "种子" 匹配已生成的图片。

    命名约定：<prefix 的目录部分>/<prefix 末段>_s<seed>_<comfy计数器>_.png
    （ComfyUI 只把 prefix 的最后一段当作文件名，目录部分作为输出子目录）
    """
    sub = os.path.dirname(prefix) if "/" in prefix else ""
    needle = "_s%d_" % seed
    target_dir = COMFY_OUTPUT
    if sub:
        target_dir = os.path.join(COMFY_OUTPUT, sub)
    if not os.path.isdir(target_dir):
        return None
    for fn in os.listdir(target_dir):
        if fn.endswith(".png") and needle in fn:
            return {"filename": fn, "subfolder": sub, "type": "output"}
    return None


# ---------- 统一编号命名 ----------
def _item_prefix(task, item, j):
    """条目级输出前缀（统一编号体系）。

    有 entry_id + out_dir 时：<out_dir>/<ID>_第<NN>张
      → 文件名最终为 <ID>_第<NN>张_s<种子>_<计数器>.png，与外部千问批量脚本完全一致，
        两个引擎（内部/外部）的产物可互相断点续跑。
    无编号信息时回退任务级 prefix（兼容旧任务）。
    """
    eid = item.get("entry_id")
    od = item.get("out_dir")
    if eid and od:
        return "%s/%02d_第%02d张" % (od, int(eid), j + 1)
    return task["prefix"]


# ---------- 任务创建 ----------
def create_task(items, width, height, steps, cfg, prefix, name="", lock_image=None, outfit_image=None):
    tid = uuid.uuid4().hex[:12]
    seed_base = int(time.time()) % 900000 + 100000
    task_items = []
    total = 0
    for idx, it in enumerate(items):
        cnt = int(it.get("count", 1))
        total += cnt
        task_items.append({
            "index": idx,
            "label": it.get("label", "段%d" % (idx + 1)),
            "positive": it.get("positive", it.get("prompt", "")),
            "negative": it.get("negative", ""),
            "seed_base": it.get("seed", seed_base + idx * 1000),
            "count": cnt,
            # 统一编号体系（可选）：条目 ID 与输出子目录，用于 <ID>_第<NN>张 命名
            "entry_id": it.get("entry_id"),
            "out_dir": it.get("out_dir"),
            "done": 0, "failed": 0, "skipped": 0,
            "images": [],
        })
    task = {
        "id": tid,
        "name": name or ("批量任务 %s" % tid[:6]),
        "status": "pending",
        "created_at": time.time(),
        "started_at": None, "finished_at": None,
        "width": width, "height": height, "steps": steps, "cfg": cfg,
        "prefix": prefix,
        "lock_image": lock_image,
        "outfit_image": outfit_image,
        "total": total,
        "done": 0, "failed": 0, "skipped": 0,
        "current_item": -1, "current_image": 0,
        "items": task_items,
        "error": None,
    }
    _save(task)
    with _lock:
        _tasks[tid] = task
    _ensure_worker()
    return task


# ---------- Worker ----------
def _ensure_worker():
    global _worker
    if _worker and _worker.is_alive():
        return
    _stop.clear()
    _worker = threading.Thread(target=_loop, name="nsfw-batch-worker", daemon=True)
    _worker.start()


def _loop():
    while not _stop.is_set():
        task = None
        with _lock:
            for t in _tasks.values():
                if t["status"] == "pending":
                    task = t
                    break
        if not task:
            time.sleep(2)
            continue
        _run(task)


def _run(task):
    task["status"] = "running"
    task["started_at"] = time.time()
    _save(task)

    for i, item in enumerate(task["items"]):
        if task["status"] == "cancelled":
            break
        task["current_item"] = i

        for j in range(item["count"]):
            if task["status"] == "cancelled":
                break
            task["current_image"] = j + 1
            seed = item["seed_base"] + j
            item_prefix = _item_prefix(task, item, j)

            # 断点续跑：已落盘则跳过
            existing = _image_exists(item_prefix, seed)
            if existing:
                item["images"].append(existing)
                item["skipped"] += 1
                task["skipped"] += 1
                _save(task)
                continue

            # 单张失败自动重试（最多 3 次），种子/前缀不变，便于断点续跑对齐；
            # 任务已被取消时不再重试，也不计入失败（当前图可能刚被协作中断）
            last_err = None
            for attempt in range(3):
                if task["status"] == "cancelled":
                    break
                try:
                    prompt = build_prompt({
                        "positive": item["positive"], "negative": item["negative"],
                        "width": task["width"], "height": task["height"],
                        "seed": seed, "steps": task["steps"], "cfg": task["cfg"],
                        "prefix": item_prefix,
                        "lock_image": task.get("lock_image"),
                        "outfit_image": task.get("outfit_image"),
                    })
                    r = requests.post(COMFY + "/prompt",
                                      json={"prompt": prompt, "client_id": CLIENT_ID},
                                      timeout=30)
                    d = r.json()
                    if "prompt_id" not in d:
                        raise Exception(str(d))
                    im = _poll(d["prompt_id"])
                    item["images"].append(im)
                    item["done"] += 1
                    task["done"] += 1
                    last_err = None
                    break
                except Exception as e:
                    last_err = e
                    if attempt < 2:
                        time.sleep(5)
            if last_err is not None and task["status"] != "cancelled":
                item["failed"] += 1
                task["failed"] += 1
                task["error"] = str(last_err)[:500]
            _save(task)

    # 只有全部完成（成功+跳过 >= 总数）才标记 done，否则标记 failed 以便重启后续跑
    if task["status"] != "cancelled":
        if task["done"] + task["skipped"] >= task["total"]:
            task["status"] = "done"
        else:
            task["status"] = "failed"
    task["finished_at"] = time.time()
    task["current_item"] = -1
    task["current_image"] = 0
    _save(task)


def _poll(pid, timeout=1800):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(COMFY + "/history/" + pid, timeout=15)
            hist = r.json()
            if pid in hist:
                entry = hist[pid]
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    msg = ""
                    for m in status.get("messages", []):
                        if m[0] == "execution_error" and m[1]:
                            msg = m[1].get("exception_message", "")
                    raise Exception(msg or "ComfyUI execution error")
                for _nid, out in entry.get("outputs", {}).items():
                    for im in out.get("images", []):
                        return im
                raise Exception("completed but no images")
        except requests.exceptions.ConnectionError:
            pass
        time.sleep(3)
    raise Exception("poll timeout (>30min)")


# ---------- 对外 API ----------
def get_task(tid):
    with _lock:
        if tid in _tasks:
            return _tasks[tid]
    return _load(tid)

def list_tasks(limit=200):
    result = []
    # 先从内存
    with _lock:
        for t in _tasks.values():
            result.append(_summary(t))
    # 再从磁盘补全
    if os.path.isdir(STATE_DIR):
        for fn in os.listdir(STATE_DIR):
            if fn.endswith(".json"):
                tid = fn[:-5]
                with _lock:
                    if tid in _tasks:
                        continue
                t = _load(tid)
                if t:
                    result.append(_summary(t))
    result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return result[:limit]

def _summary(t):
    return {
        "id": t["id"], "name": t.get("name", ""),
        "status": t["status"], "total": t["total"],
        "done": t["done"], "failed": t["failed"], "skipped": t["skipped"],
        "created_at": t.get("created_at", 0),
        "started_at": t.get("started_at"), "finished_at": t.get("finished_at"),
        "current_item": t.get("current_item", -1),
        "current_image": t.get("current_image", 0),
        "prefix": t.get("prefix", ""),
        "width": t.get("width"), "height": t.get("height"),
        "error": t.get("error"),
    }

def _cancel_own_comfy_jobs():
    """只中断/移除本引擎提交给 ComfyUI 的任务，绝不打断其他客户端（如外部批量脚本）。

    ComfyUI 的 /interrupt 是全局的：为避免误伤他人任务，先查队列确认运行中的 client_id
    属于本引擎（nsfw-batch）才发送；pending 中属于本引擎的项通过 /queue delete 移除。
    """
    try:
        q = requests.get(COMFY + "/queue", timeout=5).json()
    except Exception:
        return

    def cid(item):
        # 队列项结构：[priority, prompt_id, prompt, extra_data, outputs_to_execute]
        try:
            return (item[3] or {}).get("client_id")
        except Exception:
            return None

    pending_mine = []
    for item in q.get("queue_pending", []):
        try:
            if cid(item) == CLIENT_ID:
                pending_mine.append(item[1])
        except Exception:
            pass
    if pending_mine:
        try:
            requests.post(COMFY + "/queue", json={"delete": pending_mine}, timeout=5)
        except Exception:
            pass
    if any(cid(it) == CLIENT_ID for it in q.get("queue_running", [])):
        try:
            requests.post(COMFY + "/interrupt", timeout=10)
        except Exception:
            pass


def cancel_task(tid):
    with _lock:
        task = _tasks.get(tid)
    if not task:
        task = _load(tid)
        if task:
            with _lock:
                _tasks[tid] = task
    if task and task["status"] in ("pending", "running"):
        task["status"] = "cancelled"
        task["finished_at"] = time.time()
        _save(task)
        _cancel_own_comfy_jobs()
    return task

def delete_task(tid):
    with _lock:
        _tasks.pop(tid, None)
    p = _path(tid)
    if os.path.exists(p):
        try:
            os.remove(p)
        except Exception:
            pass
    return True


# 启动时恢复未完成的任务（pending/running/failed 状态重置为 pending；done 但未完成的也恢复）
def _resume():
    if not os.path.isdir(STATE_DIR):
        return
    for fn in os.listdir(STATE_DIR):
        if not fn.endswith(".json"):
            continue
        tid = fn[:-5]
        t = _load(tid)
        if not t:
            continue
        # pending/running/failed 直接恢复
        if t["status"] in ("pending", "running", "failed"):
            t["status"] = "pending"
            t["error"] = None
            _save(t)
            with _lock:
                _tasks[tid] = t
        # done 但实际未完成的（bug导致的错误标记），也恢复
        elif t["status"] == "done" and t.get("done", 0) + t.get("skipped", 0) < t.get("total", 0):
            t["status"] = "pending"
            t["error"] = None
            _save(t)
            with _lock:
                _tasks[tid] = t

_resume()
if any(t["status"] == "pending" for t in _tasks.values()):
    _ensure_worker()
