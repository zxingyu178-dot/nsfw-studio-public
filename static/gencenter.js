// 生成中心：统一四种生成方式（手写 / 模板 / 库 / AI 包）+ 统一任务中心
// 统一编号：散图条目 ID 从 1000 起（服务端分配），文件名 <ID>_第<NN>张_s<种子>_...
(function () {
  const $ = (s) => document.querySelector(s);
  const enc = encodeURIComponent;
  let source = "manual";          // manual | template | library | pack
  let templates = [];
  let libItems = [];
  let packData = null;            // /api/gen/pack 返回
  let currentTaskId = null;
  let taskList = [];
  let pollTimer = null;
  let queueInfo = { running: 0, pending: 0 };

  function viewUrl(im) {
    return `/api/view?filename=${enc(im.filename)}&subfolder=${enc(im.subfolder || "")}&type=${enc(im.type || "output")}`;
  }
  function fmtDur(sec) {
    if (!sec || sec < 0) return "--";
    if (sec < 60) return Math.round(sec) + "秒";
    if (sec < 3600) return Math.round(sec / 60) + "分钟";
    return (sec / 3600).toFixed(1) + "小时";
  }
  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json();
  }

  // ---------- 来源切换 ----------
  function setSource(src) {
    source = src;
    $("#gcSourceSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.src === src));
    const compose = src !== "pack";
    $("#gcCompose").style.display = compose ? "" : "none";
    $("#gcPack").style.display = compose ? "none" : "";
    $("#gcKeywordBox").style.display = src === "keyword" ? "" : "none";
    $("#gcTplPick").style.display = src === "manual" ? "" : "none";
    $("#gcLibPick").style.display = src === "library" ? "" : "none";
    $("#gcCategory").placeholder = "可选；默认按来源（" + ({ manual: "手动", keyword: "拼接", library: "库" }[src] || "手动") + "）";
    if (src === "keyword" && window.gcCompile) {
      // 进入关键词拼接：用当前选项刷新一次编译结果（写入本页提示词框）
      window.gcCompile();
    }
    if (src !== "library") clearExisting();   // 离开库来源时收起"已生成"区
    if (src === "pack") loadPack();
  }

  // ---------- 库条目：查已生成图片 ----------
  function clearExisting() {
    const box = $("#gcExisting"), lab = $("#gcExistingLabel");
    if (box) { box.style.display = "none"; box.innerHTML = ""; }
    if (lab) lab.style.display = "none";
  }
  async function lookupExisting(text) {
    clearExisting();
    if (!text) return;
    try {
      const d = await post("/api/gen/lookup", { text });
      const imgs = d.images || [];
      const lab = $("#gcExistingLabel"), box = $("#gcExisting");
      if (!imgs.length) {
        // 明确告知"查过但没有"（避免看起来像功能没反应）
        lab.textContent = "该提示词暂无生成记录";
        lab.style.display = "";
        return;
      }
      lab.textContent = `该提示词已生成的图片（${d.count} 张）`;
      lab.style.display = ""; box.style.display = "";
      box.innerHTML = imgs.map((im) => {
        const tn = `/api/thumb?filename=${enc(im.filename)}&subfolder=${enc(im.subfolder || "")}&type=${enc(im.type || "output")}`;
        const nm = im.filename.length > 24 ? im.filename.slice(0, 24) + "…" : im.filename;
        return `<a class="card gc-ex-card" href="${viewUrl(im)}" target="_blank" rel="noopener" title="点击查看原图">
          <div class="gthumb-wrap" style="aspect-ratio:2/3"><img src="${tn}" loading="lazy" class="gthumb">
          <div class="gthumb-loader"><div class="spinner"></div></div></div>
          <div class="meta"><span>${nm}</span></div></a>`;
      }).join("");
      box.querySelectorAll("img.gthumb").forEach((img) => {
        const wrap = img.closest(".gthumb-wrap");
        if (img.complete) wrap.classList.add("loaded");
        img.addEventListener("load", () => wrap.classList.add("loaded"));
      });
    } catch (e) { /* ignore */ }
  }

  // ---------- 模板 / 库 ----------
  async function loadTemplates() {
    try {
      const d = await (await fetch("/api/templates/list")).json();
      templates = d.items || [];
      const sel = $("#gcTplSelect");
      sel.innerHTML = '<option value="">选择模板…</option>' + templates.map((t) =>
        `<option value="${t.id}">${t.name || "未命名"}</option>`).join("");
    } catch (e) { /* ignore */ }
  }
  async function loadLib() {
    try {
      const d = await (await fetch("/api/promptlib/list")).json();
      libItems = d.items || [];
      const sel = $("#gcLibSelect");
      sel.innerHTML = '<option value="">选择条目…</option>' + libItems.map((t, i) =>
        `<option value="${i}">${t.name || t.id || "未命名"}</option>`).join("");
    } catch (e) { /* ignore */ }
  }
  function applyTemplate() {
    const id = parseInt($("#gcTplSelect").value, 10);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    $("#gcPositive").value = t.positive || "";
    $("#gcNegative").value = t.negative || "";
    if (t.width && t.height) $("#gcSize").value = t.width + "x" + t.height;
    if (t.steps) $("#gcSteps").value = t.steps;
    if (t.cfg) $("#gcCfg").value = t.cfg;
    if (t.count) $("#gcCount").value = t.count;
    $("#gcSubmitHint").textContent = "已填入模板（可临时修改）";
  }
  function applyLib() {
    const idx = parseInt($("#gcLibSelect").value, 10);
    const t = libItems[idx];
    if (!t) { clearExisting(); return; }
    $("#gcPositive").value = t.positive || "";
    $("#gcNegative").value = t.negative || "";
    $("#gcSubmitHint").textContent = "已填入库条目（可临时修改）";
    lookupExisting(t.positive || "");   // 查该提示词已生成的图片 → 右侧展示
  }

  // ---------- 提交（手写 / 模板 / 库） ----------
  async function submitCompose() {
    const pos = $("#gcPositive").value.trim();
    if (!pos) { alert("请先填写正面提示词"); return; }
    const size = $("#gcSize").value.split("x");
    const payload = {
      source,
      items: [{
        positive: pos,
        negative: $("#gcNegative").value.trim(),
        count: parseInt($("#gcCount").value, 10) || 1,
        name: $("#gcName").value.trim(),
        category: $("#gcCategory").value.trim(),
      }],
      width: parseInt(size[0], 10), height: parseInt(size[1], 10),
      steps: parseInt($("#gcSteps").value, 10) || 25,
      cfg: parseFloat($("#gcCfg").value) || 1.0,
    };
    const btn = $("#gcSubmitBtn");
    btn.disabled = true;
    try {
      const d = await post("/api/gen/submit", payload);
      if (!d.ok) { alert("提交失败：" + (d.error || "未知错误")); return; }
      const e = (d.entries || [])[0] || {};
      $("#gcSubmitHint").innerHTML = `已提交：编号 <b>#${e.id}</b> · 共 ${d.total} 张 · 输出目录 <code>${e.dir || ""}/</code>`;
      currentTaskId = d.id;
      await refreshTasks(false);
      startPolling();
    } catch (err) {
      alert("提交失败：" + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function saveAsTemplate() {
    const pos = $("#gcPositive").value.trim();
    if (!pos) { alert("正面提示词为空，无法保存为模板"); return; }
    const name = prompt("模板名称：", "模板 " + new Date().toLocaleString());
    if (!name) return;
    const size = $("#gcSize").value.split("x");
    await post("/api/templates/add", {
      name, positive: pos, negative: $("#gcNegative").value.trim(),
      width: parseInt(size[0], 10), height: parseInt(size[1], 10),
      steps: parseInt($("#gcSteps").value, 10) || 25,
      cfg: parseFloat($("#gcCfg").value) || 1.0,
      count: parseInt($("#gcCount").value, 10) || null,
    });
    await loadTemplates();
    $("#gcSubmitHint").textContent = "已另存为模板：" + name;
  }

  // ---------- AI 提示词包 ----------
  async function loadPack() {
    const dir = $("#gcPackDir").value.trim();
    $("#gcPackHint").textContent = "加载中…";
    try {
      const d = await (await fetch("/api/gen/pack" + (dir ? "?dir=" + enc(dir) : ""))).json();
      packData = d;
      if (!dir && d.dir) $("#gcPackDir").value = d.dir;
      renderPack();
    } catch (e) {
      $("#gcPackHint").textContent = "加载失败：" + e.message;
    }
  }
  function renderPack() {
    const d = packData || {};
    if (d.error) {
      $("#gcPackHint").textContent = "⚠ " + d.error;
      $("#gcPackList").innerHTML = "";
      return;
    }
    const items = d.items || [];
    const doneAll = items.filter((x) => x.done >= x.count).length;
    $("#gcPackHint").textContent = `包「${d.name || ""}」共 ${items.length} 条 · 已完成 ${doneAll} 条（每段 ${d.params && d.params.count_per || 16} 张，可在单条上覆盖）`;
    if ($("#gcPackCount").dataset.auto !== "0") {
      const cp = (d.params && d.params.count_per) || 16;
      $("#gcPackCount").value = cp;
    }
    $("#gcPackList").innerHTML = items.map((it) => {
      const full = it.done >= it.count;
      return `<label class="gc-pk-row${it.enabled === false ? " off" : ""}">
        <input type="checkbox" value="${it.id}" ${full ? "" : "data-unfinished=1"}>
        <span class="gc-pk-id">#${it.id}</span>
        <span class="gc-pk-title">${it.title || it.file}${it.enabled === false ? "（已停用）" : ""}</span>
        <span class="gc-pk-cat muted">${it.category || ""}</span>
        <span class="gc-pk-prog ${full ? "full" : ""}">${it.done}/${it.count}</span>
      </label>`;
    }).join("");
  }
  async function submitPack() {
    const ids = [...$("#gcPackList").querySelectorAll("input:checked")].map((cb) => parseInt(cb.value, 10));
    if (!ids.length) { alert("请先勾选要生成的条目"); return; }
    const d = await post("/api/gen/pack/submit", {
      dir: $("#gcPackDir").value.trim(),
      ids,
      count_per: parseInt($("#gcPackCount").value, 10) || 0,
    });
    if (!d.ok) { alert("提交失败：" + (d.error || "未知错误")); return; }
    $("#gcPackHint").textContent = `已提交 ${d.submitted} 条（共 ${d.total} 张）到内部批量` + (d.missing && d.missing.length ? `；${d.missing.length} 条缺失被跳过` : "");
    currentTaskId = d.id;
    await refreshTasks(false);
    startPolling();
  }

  // ---------- 任务中心 ----------
  async function refreshTasks(autoAttach = true) {
    try {
      const d = await (await fetch("/api/batch/status")).json();
      taskList = d.tasks || [];
    } catch (e) { return; }
    if (autoAttach && !currentTaskId) {
      const active = taskList.find((t) => t.status === "running" || t.status === "pending");
      if (active) { currentTaskId = active.id; startPolling(); }
    }
    renderHistory();
    refreshExtLine();
  }

  function statusLabel(s) {
    return { pending: "排队中", running: "运行中", done: "已完成", cancelled: "已停止", error: "出错", failed: "未完成" }[s] || s;
  }

  function renderHistory() {
    const el = $("#gcHistory");
    if (!taskList.length) { el.innerHTML = '<div class="empty-hint">暂无历史任务</div>'; return; }
    el.innerHTML = taskList.slice(0, 12).map((t) => {
      const done = t.done + t.failed + t.skipped;
      const pct = t.total ? Math.round(done / t.total * 100) : 0;
      const active = (t.status === "running" || t.status === "pending");
      const cur = t.id === currentTaskId ? " current" : "";
      return `<div class="bhistory${cur}" data-id="${t.id}">
        <span class="bhistory-name">${t.name || t.id.substring(0, 8)}</span>
        <span class="bstatus-tag bstatus-${t.status}">${statusLabel(t.status)}</span>
        <span class="muted">${done}/${t.total}（${pct}%）</span>
        <button class="ghost tiny" data-act="view">查看</button>
        ${active ? '<button class="danger tiny" data-act="stop">停止</button>'
                 : '<button class="ghost tiny" data-act="resume">继续</button>'}
      </div>`;
    }).join("");
    el.querySelectorAll(".bhistory").forEach((row) => {
      const id = row.dataset.id;
      row.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          if (act === "view") selectTask(id);
          else if (act === "stop") stopTask(id);
          else if (act === "resume") resumeTask(id);
        });
      });
      row.addEventListener("click", () => selectTask(id));
    });
  }

  function selectTask(id) {
    currentTaskId = id;
    renderHistory();
    startPolling();
  }

  async function stopTask(id) {
    if (!confirm("停止该任务？\n已生成的图片全部保留，之后可「继续」断点续跑")) return;
    await post("/api/batch/cancel", { id });
    setTimeout(() => { pollStatus(); refreshTasks(false); }, 900);
  }

  async function resumeTask(id) {
    try {
      const t = await (await fetch("/api/batch/status?id=" + enc(id))).json();
      if (!t || !t.items || !t.items.length) { alert("任务信息不完整，无法继续"); return; }
      const d = await post("/api/batch/create", {
        items: t.items.map((it) => ({
          label: it.label, positive: it.positive, negative: it.negative, count: it.count,
          seed: it.seed_base, entry_id: it.entry_id, out_dir: it.out_dir,
        })),
        width: t.width, height: t.height, steps: t.steps, cfg: t.cfg,
        prefix: t.prefix,
        name: (t.name || t.id.substring(0, 8)) + "（续）",
      });
      if (d.error) { alert("继续失败：" + d.error); return; }
      currentTaskId = d.id;
      await refreshTasks(false);
      startPolling();
    } catch (e) { alert("继续失败：" + e.message); }
  }

  async function fetchQueue() {
    try {
      const d = await (await fetch("/api/queue")).json();
      queueInfo = { running: (d.queue_running || []).length, pending: (d.queue_pending || []).length };
    } catch (e) { /* ignore */ }
  }

  async function pollStatus() {
    if (!currentTaskId) return;
    try {
      const task = await (await fetch("/api/batch/status?id=" + enc(currentTaskId))).json();
      if (!task || task.error || !task.status) { stopPolling(); return; }
      await fetchQueue();
      renderStatus(task);
      if (task.status === "done" || task.status === "cancelled" || task.status === "error" || task.status === "failed") {
        stopPolling();
        refreshTasks(false);
      }
    } catch (e) { /* ignore */ }
  }

  function renderStatus(task) {
    const done = task.done + task.failed + task.skipped;
    const pct = task.total ? Math.round(done / task.total * 100) : 0;
    const el = $("#gcStatus");
    let elapsed = 0, eta = 0, perImage = 160;
    if (task.started_at) elapsed = Date.now() / 1000 - task.started_at;
    if (task.finished_at && task.started_at) elapsed = task.finished_at - task.started_at;
    if (done > 0 && elapsed > 10) {
      perImage = elapsed / done;
      eta = Math.max(0, (task.total - done) * perImage);
    }
    let currentLabel = "等待中";
    let segPct = 0;
    if (task.current_item >= 0 && task.items && task.items[task.current_item]) {
      const it = task.items[task.current_item];
      const segDone = (task.current_image || 0) - 1;
      segPct = it.count ? Math.round(segDone / it.count * 100) : 0;
      const eid = it.entry_id ? `#${it.entry_id} · ` : "";
      currentLabel = `第 ${task.current_item + 1}/${task.items.length} 段 · ${eid}${it.label}（${segDone}/${it.count}）`;
    }
    const active = (task.status === "running" || task.status === "pending");
    el.innerHTML = `
      <div class="bstatus-head">
        <span class="bstatus-name">${task.name || task.id}</span>
        <span class="bstatus-tag bstatus-${task.status}">${statusLabel(task.status)}</span>
      </div>
      <div class="bprogress"><div class="bprogress-bar" style="width:${pct}%"></div></div>
      <div class="bstatus-stats">
        <span>进度 <b>${done}/${task.total}</b>（${pct}%）</span>
        <span class="ok">成功 ${task.done}</span>
        <span class="muted">跳过 ${task.skipped}</span>
        <span class="warn">失败 ${task.failed}</span>
      </div>
      <div class="bstatus-stats" style="margin-top:4px">
        <span class="muted">已耗时 ${fmtDur(elapsed)}</span>
        <span class="muted">单张约 ${Math.round(perImage)}秒</span>
        <span class="accent">预计剩余 ${fmtDur(eta)}</span>
        <span class="muted">ComfyUI 队列：${queueInfo.running} 运行 / ${queueInfo.pending} 等待</span>
      </div>
      <div class="bstatus-current">${currentLabel}</div>
      ${task.current_item >= 0 ? `<div class="seg-progress"><div class="seg-progress-bar" style="width:${segPct}%"></div></div>` : ""}
      ${task.error ? `<div class="bstatus-error">${task.error}</div>` : ""}
      <div class="bstatus-actions">
        ${active ? '<button class="danger small" data-bact="stop">停止任务</button>' : ""}
        ${!active ? '<button class="ghost small" data-bact="resume">继续（断点续跑）</button>' : ""}
        <button class="ghost small" data-bact="gallery">查看图库</button>
      </div>`;
    el.querySelectorAll("[data-bact]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.dataset.bact;
        if (act === "stop") stopTask(task.id);
        else if (act === "resume") resumeTask(task.id);
        else if (act === "gallery") window.showPage("gallery");
      });
    });
    // 预览当前段已生成图片
    if (task.current_item >= 0 && task.items && task.items[task.current_item]) {
      const it = task.items[task.current_item];
      if (it.images && it.images.length) {
        const gal = $("#gcGallery");
        const wasAtBottom = gal.scrollTop + gal.clientHeight >= gal.scrollHeight - 50;
        const ar = (task.width && task.height) ? (task.width + " / " + task.height) : "2 / 3";
        gal.innerHTML = it.images.map((im, i) => {
          const tn = `/api/thumb?filename=${enc(im.filename)}&subfolder=${enc(im.subfolder || "")}&type=output`;
          return `<div class="card">
            <div class="gthumb-wrap" style="aspect-ratio:${ar}"><img src="${tn}" alt="p${i}" loading="lazy" class="gthumb">
            <div class="gthumb-loader"><div class="spinner"></div></div></div>
            <div class="meta"><span>#${i + 1}</span><a href="${viewUrl(im)}" download="${im.filename}">下载</a></div>
          </div>`;
        }).join("");
        gal.querySelectorAll("img.gthumb").forEach((img) => {
          const wrap = img.closest(".gthumb-wrap");
          if (img.complete) wrap.classList.add("loaded");
          img.addEventListener("load", () => wrap.classList.add("loaded"));
        });
        if (wasAtBottom) gal.scrollTop = gal.scrollHeight;
      }
    }
  }

  async function refreshExtLine() {
    const el = $("#gcExtLine");
    if (!el) return;
    try {
      const d = await (await fetch("/api/batch/external")).json();
      const state = d.running
        ? (d.stop_flag ? "停止中（当前张跑完退出）" : `运行中 · ${d.current_segment ? "第" + (d.current_seg_num || "?") + "段 " + d.current_segment : "准备中"}`)
        : "未运行";
      el.innerHTML = `<span class="muted">外部千问脚本：${state} · ${d.done}/${d.total}</span>
        <button class="ghost tiny" id="gcExtGo">去批量页</button>`;
      const go = document.getElementById("gcExtGo");
      if (go) go.addEventListener("click", () => window.showPage("batch"));
    } catch (e) { el.textContent = ""; }
  }

  function startPolling() {
    stopPolling();
    pollStatus();
    pollTimer = setInterval(pollStatus, 5000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---------- 绑定 ----------
  $("#gcSourceSeg").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => setSource(b.dataset.src));
  });
  $("#gcTplSelect").addEventListener("change", applyTemplate);
  $("#gcLibSelect").addEventListener("change", applyLib);
  $("#gcSubmitBtn").addEventListener("click", submitCompose);
  $("#gcSaveTplBtn").addEventListener("click", saveAsTemplate);
  $("#gcPackReload").addEventListener("click", loadPack);
  $("#gcPackSubmitBtn").addEventListener("click", submitPack);
  $("#gcPackCount").addEventListener("change", () => { $("#gcPackCount").dataset.auto = "0"; });
  $("#gcPackAllBtn").addEventListener("click", () => {
    $("#gcPackList").querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.checked = !!cb.dataset.unfinished;
    });
  });

  // 暴露给 nav.js
  window.gencenterRefresh = function () {
    loadTemplates();
    loadLib();
    refreshTasks();
    refreshExtLine();
  };

  // 初始化
  setSource("manual");
  loadTemplates();
  loadLib();
  refreshTasks();
  refreshExtLine();
  setInterval(() => { if (!pollTimer) refreshExtLine(); }, 15000);   // 外部脚本状态轻量轮询
})();