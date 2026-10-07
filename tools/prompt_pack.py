# -*- coding: utf-8 -*-
"""提示词包工具（Prompt Pack）——批量生图统一规范 v1 的可执行版本。

用法：
  python prompt_pack.py check <包目录>                 校验（格式 / 编号 / 重复 / manifest 一致性）
  python prompt_pack.py init  <包目录> [--legacy-desc] [--name 名称]
                                                       生成或刷新 manifest.json（分配稳定 ID）

规范 v1（每个提示词一个 .txt）：
  文件名：<分类>_<编号>_<标题>.txt          例：L5全裸_11_森林溪流.txt
  内容：
    # <标题注释>            ← 必须至少一行 "#' 开头（建议第 1 行）
    # <标签行>              ← 可选，可多行
    <正面提示词>            ← 可多段
    NEG:                    ← 独立成行（兼容全角 NEG：）
    <负面提示词>            ← 可空（空则运行时使用默认负面词）

manifest.json 是批量执行的唯一事实源：
  - items 数组顺序 = 执行顺序（可随意调整，不影响任何已生成图片）
  - 每项含稳定 id（一经分配永不改变）；种子 = seed_base + id * seed_step，与 id 绑定，
    因此“插入新提示词”不会让任何已有段的种子/文件名错位
  - 每项可选字段：count（该段张数，覆盖全局 count_per）、enabled（false 则跳过）

退出码：check 有 error 时返回 1；init 成功返回 0。
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

NAME_RE = re.compile(r"^(.+?)_(\d{1,3})_(.+)$")

DEFAULT_PARAMS = {
    "count_per": 16, "width": 832, "height": 1216, "steps": 25,
    "cfg": 1.0, "seed_base": 180000, "seed_step": 100,
}

MANIFEST_NAME = "manifest.json"


# ---------- 解析与体检 ----------
def analyze_file(fp):
    """按规范 v1 解析并体检一个提示词文件。返回 dict（含 errors/warnings/info）。"""
    r = {"file": os.path.basename(fp), "errors": [], "warnings": [], "info": []}
    try:
        raw = open(fp, "rb").read()
    except OSError as e:
        r["errors"].append("无法读取: %s" % e)
        return r
    r["bom"] = raw.startswith(b"\xef\xbb\xbf")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        r["errors"].append("不是 UTF-8 编码: %s" % e)
        return r

    pos, neg, in_neg = [], [], False
    has_title = has_neg = fullwidth = False
    for ln in text.splitlines():
        s = ln.strip()
        if not s:
            continue
        if s.startswith("#"):
            if not pos and not in_neg and not has_neg:
                has_title = True
            continue
        if s.upper().startswith(("NEG:", "NEG：")):
            has_neg = True
            if s.upper().startswith("NEG："):
                fullwidth = True
            rest = s[4:].strip()
            if rest:
                neg.append(rest)
            in_neg = True
            continue
        (neg if in_neg else pos).append(s)

    r["pos"] = " ".join(pos).strip()
    r["neg"] = " ".join(neg).strip()
    if r["bom"]:
        r["info"].append("带 BOM（建议去掉；解析端已兼容，不影响使用）")
    if not has_title:
        r["warnings"].append('缺少 "# 标题" 注释行')
    if not r["pos"]:
        r["errors"].append("正面提示词为空")
    if not has_neg:
        r["warnings"].append("缺少 NEG: 行（将使用默认负面词）")
    elif not r["neg"]:
        r["info"].append("NEG: 后为空（将使用默认负面词）")
    if fullwidth:
        r["info"].append("使用了全角 NEG：（解析兼容；建议统一半角）")

    stem = os.path.splitext(r["file"])[0]
    m = NAME_RE.match(stem)
    if m:
        r["category"], r["number"], r["title"] = m.group(1), m.group(2), m.group(3)
    else:
        r["category"], r["number"], r["title"] = "", "", stem
        r["warnings"].append("文件名不符合 <分类>_<编号>_<标题>.txt（按无编号处理）")
    return r


def list_pack_files(d):
    return sorted(glob.glob(os.path.join(d, "*.txt")))


def load_manifest(d):
    p = os.path.join(d, MANIFEST_NAME)
    if not os.path.isfile(p):
        return None
    try:
        with open(p, "r", encoding="utf-8-sig") as f:
            m = json.load(f)
        return m if isinstance(m, dict) else None
    except Exception as e:
        print("!! manifest.json 解析失败：%s" % e)
        return None


# ---------- check ----------
def cmd_check(args):
    d = args.dir
    if not os.path.isdir(d):
        print("!! 目录不存在：%s" % d)
        return 2
    files = list_pack_files(d)
    if not files:
        print("!! 目录下没有 .txt 提示词：%s" % d)
        return 2

    reports = [analyze_file(fp) for fp in files]
    errors = warnings = 0

    print("== 提示词包校验（规范 v1）==")
    print("目录: %s" % d)
    print("文件数: %d\n" % len(reports))

    # 编号重复
    by_num = {}
    for r in reports:
        if r.get("number"):
            by_num.setdefault(r["number"], []).append(r["file"])
    dup_num = {k: v for k, v in by_num.items() if len(v) > 1}

    # 内容重复（正面归一化后相同）
    by_pos = {}
    for r in reports:
        key = re.sub(r"\s+", "", r.get("pos", ""))
        if key:
            by_pos.setdefault(key, []).append(r["file"])
    dup_pos = {k: v for k, v in by_pos.items() if len(v) > 1}

    for r in reports:
        issues = r["errors"] + r["warnings"] + r["info"]
        if not issues:
            print("OK    %s" % r["file"])
            continue
        tag = "ERROR" if r["errors"] else ("WARN " if r["warnings"] else "INFO ")
        print("%s %s" % (tag, r["file"]))
        for e in r["errors"]:
            print("        [error] %s" % e)
        for w in r["warnings"]:
            print("        [warn ] %s" % w)
        for i in r["info"]:
            print("        [info ] %s" % i)
        errors += len(r["errors"])
        warnings += len(r["warnings"])

    if dup_num:
        print("\n编号重复：")
        for k, v in sorted(dup_num.items()):
            print("  [warn ] _%s_ 出现在：%s" % (k, "、".join(v)))
            warnings += 1
    if dup_pos:
        print("\n内容重复（正面词完全一致）：")
        for k, v in dup_pos.items():
            print("  [warn ] %s" % "、".join(v))
            warnings += 1

    # manifest 一致性
    man = load_manifest(d)
    if man:
        listed = [it.get("file") for it in man.get("items", [])]
        disk = set(os.path.basename(fp) for fp in files)
        missing_in_manifest = sorted(disk - set(listed))
        missing_on_disk = sorted(set(listed) - disk)
        if missing_in_manifest:
            print("\n文件未登记进 manifest：")
            for f in missing_in_manifest:
                print("  [error] %s" % f)
            errors += len(missing_in_manifest)
        if missing_on_disk:
            print("\nmanifest 登记了但目录中缺失的文件：")
            for f in missing_on_disk:
                print("  [error] %s" % f)
            errors += len(missing_on_disk)
        ids = [it.get("id") for it in man.get("items", [])]
        if len(ids) != len(set(ids)):
            print("\n  [error] manifest 中存在重复 id")
            errors += 1
        if not missing_in_manifest and not missing_on_disk:
            print("\nmanifest 一致性：OK（%d 项）" % len(listed))
    else:
        print("\n（未发现 manifest.json；如需清单化请运行：prompt_pack.py init \"%s\"）" % d)

    print("\n---- 汇总：error %d / warn %d / 文件 %d ----" % (errors, warnings, len(reports)))
    return 1 if errors else 0


# ---------- init ----------
def _sort_key(path):
    """新标准执行顺序：文件名中的编号升序；无编号的排在最后。"""
    stem = os.path.splitext(os.path.basename(path))[0]
    m = NAME_RE.match(stem)
    if m:
        return (0, int(m.group(2)), stem)
    return (1, 0, stem)


def cmd_init(args):
    d = args.dir
    if not os.path.isdir(d):
        print("!! 目录不存在：%s" % d)
        return 2
    files = list_pack_files(d)
    if not files:
        print("!! 目录下没有 .txt 提示词：%s" % d)
        return 2

    man = load_manifest(d)
    by_file = {}
    if man:  # 已有清单：保留既有 ID，仅给新文件分配
        for it in man.get("items", []):
            if it.get("file"):
                by_file[it["file"]] = it
        next_id = int(man.get("next_id", max([it.get("id", 0) for it in man.get("items", [])] + [0]) + 1))
    else:
        next_id = 1
        if args.legacy_desc:
            # 首次为存量目录建清单：按历史运行顺序（文件名倒序）分配 1..N，
            # 使"种子 = seed_base + id*seed_step"与既有输出文件命名完全兼容，
            # 已生成的图片继续被断点续跑正确跳过。
            for i, fp in enumerate(sorted(glob.glob(os.path.join(d, "*.txt")), reverse=True)):
                by_file[os.path.basename(fp)] = {"id": i + 1}
            next_id = len(by_file) + 1
        else:
            for i, fp in enumerate(sorted(files, key=_sort_key)):
                by_file[os.path.basename(fp)] = {"id": i + 1}
            next_id = len(by_file) + 1

    items = []
    added = 0
    for fp in sorted(files, key=_sort_key):
        fn = os.path.basename(fp)
        info = analyze_file(fp)
        entry = by_file.get(fn)
        if entry is None:
            entry = {"id": next_id}
            next_id += 1
            added += 1
            by_file[fn] = entry
        item = {
            "id": entry["id"],
            "file": fn,
            "category": info.get("category", ""),
            "number": info.get("number", ""),
            "title": info.get("title", ""),
            "enabled": entry.get("enabled", True),
        }
        if isinstance(entry.get("count"), int):
            item["count"] = entry["count"]  # 每段张数自定义（可选）
        items.append(item)

    missing = [fn for fn in by_file if fn not in set(os.path.basename(fp) for fp in files)]

    manifest = {
        "version": 1,
        "name": args.name or os.path.basename(os.path.normpath(d)),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "params": dict(DEFAULT_PARAMS),
        "next_id": next_id,
        "items": items,
    }
    out = os.path.join(d, MANIFEST_NAME)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print("== 清单已生成：%s ==" % out)
    print("条目: %d 项（新增 %d，保留原有 ID %d）" % (len(items), added, len(items) - added))
    print("next_id: %d（新提示词将从此编号开始，永不复用）" % next_id)
    if missing:
        print("!! manifest 中以下文件已不存在（保留条目，请人工处理）：")
        for fn in sorted(missing):
            print("   - %s" % fn)
    print("\n执行顺序（items 数组顺序，前 10 项）：")
    for it in items[:10]:
        print("  #%s  %s" % (it["id"], it["file"]))
    if len(items) > 10:
        print("  ...（共 %d 项）" % len(items))
    return 0


def main():
    ap = argparse.ArgumentParser(description="提示词包工具（规范 v1：校验 / 清单生成）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("check", help="校验提示词包")
    p1.add_argument("dir", help="包目录（含 .txt 与可选 manifest.json）")
    p2 = sub.add_parser("init", help="生成/刷新 manifest.json（分配稳定 ID）")
    p2.add_argument("dir", help="包目录")
    p2.add_argument("--legacy-desc", action="store_true",
                    help="首次建清单时按历史运行顺序（文件名倒序）分配 ID，与既有输出命名兼容")
    p2.add_argument("--name", default="", help="清单名称（默认取目录名）")
    args = ap.parse_args()
    if args.cmd == "check":
        sys.exit(cmd_check(args))
    else:
        sys.exit(cmd_init(args))


if __name__ == "__main__":
    main()