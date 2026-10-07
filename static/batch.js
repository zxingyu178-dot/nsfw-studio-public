// 批量生图页面：提示词草稿 + 批量任务提交/停止/继续 + 实时进度
(function () {
  const $ = (s) => document.querySelector(s);
  const enc = encodeURIComponent;
  const LS_KEY = "nsfwstudio.batch.draft.v1";

  let items = [];              // {id, name, positive, negative, count}
  let nextId = 1;
  let currentTaskId = null;    // 面板当前展示/控制的任务
  let pollTimer = null;
  let taskList = [];           // 最近一次任务列表（含 running/pending）
  let queueInfo = { running: 0, pending: 0 };
  let editingId = null;        // 弹窗编辑中的条目 id；null = 新增
  let plItems = [];            // 提示词库缓存（导入弹窗用）

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

  // ---------- 草稿持久化（刷新不丢） ----------
  function saveDraft() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(items)); } catch (e) { /* ignore */ }
  }
  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
      if (Array.isArray(d) && d.length) {
        items = d.map((x) => ({
          id: parseInt(x.id, 10) || nextId++,
          name: x.name || "", positive: x.positive || "", negative: x.negative || "",
          count: Math.max(1, parseInt(x.count, 10) || 1),
        }));
        nextId = items.reduce((m, x) => Math.max(m, x.id + 1), nextId);
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- 提示词列表 ----------
  function renderList() {
    const el = $("#batchList");
    if (!items.length) {
      el.innerHTML = '<div class="empty-hint">点击「＋ 添加」手动填写，或「从提示词库导入」批量选择</div>';
      updateSubmitState();
      return;
    }
    const totalImgs = items.reduce((s, x) => s + x.count, 0);
    el.innerHTML = `<div class="blist-sum">${items.length} 段 · 共 ${totalImgs} 张</div>` + items.map((it, idx) => `
      <div class="bitem" data-id="${it.id}">
        <div class="bitem-head">
          <span class="bitem-idx">${idx + 1}</span>
          <span class="bitem-name" title="${it.name}">${it.name || "(未命名)"}</span>
          <span class="bitem-count">×${it.count}</span>
          <div class="bitem-actions">
            <button class="ghost tiny" data-act="edit">编辑</button>
            <button class="ghost tiny" data-act="up">↑</button>
            <button class="ghost tiny" data-act="down">↓</button>
            <button class="danger tiny" data-act="del">×</button>
          </div>
        </div>
        <div class="bitem-preview">${(it.positive || "").substring(0, 120)}${(it.positive || "").length > 120 ? "…" : ""}</div>
      </div>
    `).join("");
    el.querySelectorAll(".bitem").forEach((card) => {
      const id = parseInt(card.dataset.id, 10);
      card.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const act = btn.dataset.act;
          const idx = items.findIndex((x) => x.id === id);
          if (idx < 0) return;
          if (act === "del") { items.splice(idx, 1); renderList(); saveDraft(); }
          else if (act === "up" && idx > 0) { [items[idx - 1], items[idx]] = [items[idx], items[idx - 1]]; renderList(); saveDraft(); }
          else if (act === "down" && idx < items.length - 1) { [items[idx + 1], items[idx]] = [items[idx], items[idx + 1]]; renderList(); saveDraft(); }
          else if (act === "edit") openItemModal(id);
        });
      });
      // 双击条目也能编辑
      card.querySelector(".bitem-preview").addEventListener("dblclick", () => openItemModal(id));
    });
    updateSubmitState();
  }

  // ---------- 弹窗：新增 / 编辑条目 ----------
  function openItemModal(id) {
    editingId = (id === undefined || id === null) ? null : id;
    const it = editingId === null ? null : items.find((x) => x.id === editingId);
    $("#bModalTitle").textContent = it ? "编辑提示词" : "添加提示词";
    $("#bName").value = it ? it.name : "新提示词 " + nextId;
    $("#bPositive").value = it ? it.positive : "";
    $("#bNegative").value = it ? (it.negative || "") : "";
    $("#bCount").value = it ? it.count : ($("#batchCount") ? $("#batchCount").value : 16);
    $("#bModal").style.display = "flex";
    setTimeout(() => $("#bPositive").focus(), 50);
  }
  function closeItemModal() { $("#bModal").style.display = "none"; editingId = null; }
  function saveItemModal() {
    const name = $("#bName").value.trim() || "未命名";
    const positive = $("#bPositive").value.trim();
    const negative = $("#bNegative").value.trim();
    const count = Math.max(1, parseInt($("#bCount").value, 10) || 1);
    if (!positive) { alert("请填写正面提示词"); return; }
    if (editingId !== null) {
      const it = items.find((x) => x.id === editingId);
      if (it) { it.name = name; it.positive = positive; it.negative = negative; it.count = count; }
    } else {
      items.push({ id: nextId++, name, positive, negative, count });
    }
    closeItemModal();
    renderList();
    saveDraft();
  }

  // ---------- 弹窗：从提示词库导入 ----------
  async function openImportModal() {
    try {
      const r = await fetch("/api/promptlib/list");
      const d = await r.json();
      plItems = d.items || [];
      if (!plItems.length) { alert("提示词库为空，请先在「提示词库」页面添加或导入"); return; }
      $("#biSearch").value = "";
      renderImportList();
      $("#biModal").style.display = "flex";
    } catch (e) { alert("读取提示词库失败：" + e.message); }
  }
  function renderImportList() {
    const q = $("#biSearch").value.trim().toLowerCase();
    const list = plItems.map((x, i) => ({ x, i })).filter(({ x }) =>
      !q || (x.name || "").toLowerCase().includes(q) || (x.positive || "").toLowerCase().includes(q));
    const el = $("#biList");
    if (!list.length) { el.innerHTML = '<div class="empty-hint">没有匹配的提示词</div>'; }
    else {
      el.innerHTML = list.map(({ x, i }) => `
        <label class="bim-item">
          <input type="checkbox" value="${i}">
          <span class="bim-name">${x.name || "(未命名)"}</span>
          <span class="bim-len muted">${(x.positive || "").length}字</span>
          <span class="bim-preview">${(x.positive || "").substring(0, 60)}</span>
        </label>`).join("");
    }
    updateImportCount();
    el.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.addEventListener("change", updateImportCount));
  }
  function updateImportCount() {
    const n = $("#biList").querySelectorAll("input:checked").length;
    $("#biCount").textContent = n ? `已选 ${n} 段` : "";
  }
  function closeImportModal() { $("#biModal").style.display = "none"; }
  function doImport() {
    const idxs = [...$("#biList").querySelectorAll("input:checked")].map((cb) => parseInt(cb.value, 10));
    if (!idxs.length) { alert("请先勾选要导入的提示词"); return; }
    const globalCount = Math.max(1, parseInt($("#batchCount").value, 10) || 16);
    idxs.map((i) => plItems[i]).filter(Boolean).forEach((p) => {
      items.push({ id: nextId++, name: p.name || "未命名", positive: p.positive || "", negative: p.negative || "", count: globalCount });
    });
    closeImportModal();
    renderList();
    saveDraft();
  }

  // ---------- 任务控制 ----------
  function updateSubmitState() {
    const active = taskList.filter((t) => t.status === "running" || t.status === "pending").length;
    const btn = $("#batchSubmitBtn");
    btn.textContent = active ? `当前有 ${active} 个任务（继续提交将排队）` : "提交批量任务";
    const canStop = !!currentTaskId && taskList.some((t) => t.id === currentTaskId && (t.status === "running" || t.status === "pending"));
    const footer = $("#batchCancelBtn");
    footer.disabled = !canStop;
    footer.textContent = canStop ? "停止当前任务" : "停止当前任务（未选中）";
  }

  async function submitBatch() {
    if (!items.length) { alert("请先添加提示词"); return; }
    const size = $("#batchSize").value.split("x");
    const payload = {
      items: items.map((it) => ({ label: it.name, positive: it.positive, negative: it.negative, count: it.count })),
      width: parseInt(size[0], 10), height: parseInt(size[1], 10),
      steps: parseInt($("#batchSteps").value, 10),
      cfg: parseFloat($("#batchCfg").value),
      prefix: $("#batchPrefix").value || "nsfw-studio/batch",
      name: $("#batchName").value || "",
    };
    const queued = taskList.filter((t) => t.status === "running" || t.status === "pending").length;
    if (queued > 0 && !confirm(`当前有 ${queued} 个任务在排队/运行。\n继续提交会排在其后依次执行，确定提交？`)) return;
    try {
      const d = await post("/api/batch/create", payload);
      if (d.error) { alert(d.error); return; }
      currentTaskId = d.id;
      if (queued > 0) $("#batchStatus").innerHTML = `<div class="empty-hint">任务已加入队列（前面还有 ${queued} 个），等待开始…</div>`;
      await refreshTasks(false);
      startPolling();
    } catch (e) { alert("提交失败：" + e.message); }
  }

  // 拉取任务列表；autoAttach=true 时自动接管正在运行/排队的任务（刷新后也能直接控制）
  async function refreshTasks(autoAttach = true) {
    try {
      const r = await fetch("/api/batch/status");
      const d = await r.json();
      taskList = d.tasks || [];
    } catch (e) { return; }
    if (autoAttach && !currentTaskId) {
      const active = taskList.find((t) => t.status === "running" || t.status === "pending");
      if (active) { currentTaskId = active.id; startPolling(); }
    }
    renderHistory();
    updateSubmitState();
  }

  function renderHistory() {
    const el = $("#batchHistoryList");
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
        ${active
          ? '<button class="danger tiny" data-act="stop">停止</button>'
          : '<button class="ghost tiny" data-act="resume">继续</button>'}
        <button class="danger tiny" data-act="del">删除</button>
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
          else if (act === "del") delTask(id);
        });
      });
      row.addEventListener("click", () => selectTask(id));
    });
  }

  function selectTask(id) {
    currentTaskId = id;
    renderHistory();
    updateSubmitState();
    startPolling();
  }

  async function stopTask(id) {
    if (!confirm("停止该任务？\n\n· 会中断本工具当前正在生成的这一张（外部批量脚本不受影响）\n· 已生成的图片全部保留\n· 之后可以点「继续」按种子跳过已生成图片，断点续跑")) return;
    await post("/api/batch/cancel", { id });
    if (currentTaskId === id) $("#batchStatus").innerHTML = '<div class="empty-hint">正在停止…</div>';
    setTimeout(() => { pollStatus(); refreshTasks(false); }, 900);
  }

  // 继续：用原任务的参数与种子重新建一个任务；引擎按种子跳过已落盘的图 = 断点续跑
  async function resumeTask(id) {
    try {
      const r = await fetch("/api/batch/status?id=" + enc(id));
      const t = await r.json();
      if (!t || !t.items || !t.items.length) { alert("任务信息不完整，无法继续"); return; }
      const payload = {
        items: t.items.map((it) => ({ label: it.label, positive: it.positive, negative: it.negative, count: it.count, seed: it.seed_base })),
        width: t.width, height: t.height, steps: t.steps, cfg: t.cfg, prefix: t.prefix,
        name: (t.name || t.id.substring(0, 8)) + "（续）",
      };
      const d = await post("/api/batch/create", payload);
      if (d.error) { alert("继续失败：" + d.error); return; }
      currentTaskId = d.id;
      $("#batchStatus").innerHTML = '<div class="empty-hint">已加入队列（断点续跑，已生成的图会自动跳过）…</div>';
      await refreshTasks(false);
      startPolling();
    } catch (e) { alert("继续失败：" + e.message); }
  }

  async function delTask(id) {
    if (!confirm("删除该任务记录？（不会删除已生成的图片）")) return;
    const d = await post("/api/batch/delete", { id });
    if (d && d.error) { alert(d.error); return; }
    if (currentTaskId === id) { currentTaskId = null; stopPolling(); $("#batchStatus").innerHTML = '<div class="empty-hint">尚未提交批量任务</div>'; }
    refreshTasks(false);
  }

  // ---------- 进度轮询与状态卡 ----------
  async function fetchQueue() {
    try {
      const r = await fetch("/api/queue");
      const d = await r.json();
      queueInfo = { running: (d.queue_running || []).length, pending: (d.queue_pending || []).length };
    } catch (e) { /* ignore */ }
  }

  async function pollStatus() {
    if (!currentTaskId) return;
    try {
      const r = await fetch("/api/batch/status?id=" + enc(currentTaskId));
      const task = await r.json();
      if (!task || task.error || !task.status) { stopPolling(); return; }
      await fetchQueue();
      try {
        renderStatus(task);
      } catch (err) {
        // 渲染异常不能静默：至少让面板显示原始状态，便于排查
        console.error("批量状态渲染失败", err);
        const el = $("#batchStatus");
        if (el) el.innerHTML = `<div class="bstatus-error">状态渲染失败：${err && err.message ? err.message : err}</div>
          <div class="bstatus-stats"><span>${task.name || task.id}</span><span class="bstatus-tag bstatus-${task.status}">${statusLabel(task.status)}</span>
          <span>进度 ${task.done + task.failed + task.skipped}/${task.total}</span></div>`;
      }
      if (task.status === "done" || task.status === "cancelled" || task.status === "error") {
        stopPolling();
        refreshTasks(false);
      }
    } catch (e) { /* ignore */ }
  }

  function renderStatus(task) {
    const done = task.done + task.failed + task.skipped;
    const pct = task.total ? Math.round(done / task.total * 100) : 0;
    const el = $("#batchStatus");

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
      currentLabel = `第 ${task.current_item + 1}/${task.items.length} 段 · ${it.label}（${segDone}/${it.count}）`;
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
      ${task.current_item >= 0 && task.items && task.items[task.current_item] ? `
        <div class="seg-progress"><div class="seg-progress-bar" style="width:${segPct}%"></div></div>
      ` : ""}
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

    // 预览当前段已生成的图（缩略图，自动滚动到底部）
    if (task.current_item >= 0 && task.items && task.items[task.current_item]) {
      const it = task.items[task.current_item];
      if (it.images && it.images.length) {
        const gal = $("#batchGallery");
        const wasAtBottom = gal.scrollTop + gal.clientHeight >= gal.scrollHeight - 50;
        const ar = (task.width && task.height) ? (task.width + " / " + task.height) : "2 / 3";
        gal.innerHTML = it.images.map((im, i) => {
          const sub = im.subfolder || "";
          const tn = `/api/thumb?filename=${enc(im.filename)}&subfolder=${enc(sub)}&type=output`;
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
    updateSubmitState();
  }

  function statusLabel(s) {
    return { pending: "排队中", running: "运行中", done: "已完成", cancelled: "已停止", error: "出错" }[s] || s;
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
  $("#batchAddBtn").addEventListener("click", () => openItemModal(null));
  $("#batchImportBtn").addEventListener("click", openImportModal);
  $("#batchClearBtn").addEventListener("click", () => {
    if (items.length && !confirm("清空所有提示词？")) return;
    items = []; renderList(); saveDraft();
  });
  $("#batchSubmitBtn").addEventListener("click", submitBatch);
  $("#batchCancelBtn").addEventListener("click", () => { if (currentTaskId) stopTask(currentTaskId); });

  $("#bSaveBtn").addEventListener("click", saveItemModal);
  $("#bCancelBtn").addEventListener("click", closeItemModal);
  $("#bModalBg").addEventListener("click", closeItemModal);
  $("#biCancelBtn").addEventListener("click", closeImportModal);
  $("#biModalBg").addEventListener("click", closeImportModal);
  $("#biImportBtn").addEventListener("click", doImport);
  $("#biSearch").addEventListener("input", renderImportList);
  $("#biSelectAll").addEventListener("click", () => {
    const cbs = [...$("#biList").querySelectorAll("input[type=checkbox]")];
    const allChecked = cbs.length && cbs.every((c) => c.checked);
    cbs.forEach((c) => { c.checked = !allChecked; });
    updateImportCount();
  });

  // 暴露给 nav.js
  window.batchRefresh = function () { refreshTasks(); if (currentTaskId) startPolling(); };

  // ---------- 外部批量脚本（状态 + 启停控制） ----------
  const EXT_KEY = "nsfwstudio.ext.params.v1";
  let extTimer = null;
  let extBusy = false;   // 启停请求进行中，避免连点

  function extParams() {
    const c = parseInt($("#extCount").value, 10);
    const s = parseInt($("#extStart").value, 10);
    return { count: Math.min(64, Math.max(1, c || 16)), start: Math.max(1, s || 1) };
  }
  function loadExtParams() {
    try {
      const d = JSON.parse(localStorage.getItem(EXT_KEY) || "{}");
      if (d && d.count) $("#extCount").value = Math.min(64, Math.max(1, parseInt(d.count, 10) || 16));
      if (d && d.start) $("#extStart").value = Math.max(1, parseInt(d.start, 10) || 1);
    } catch (e) { /* ignore */ }
  }
  function saveExtParams() {
    try { localStorage.setItem(EXT_KEY, JSON.stringify(extParams())); } catch (e) { /* ignore */ }
  }

  async function pollExternal() {
    try {
      const r = await fetch("/api/batch/external");
      const d = await r.json();
      renderExternal(d);
    } catch (e) {
      const body = document.getElementById("extBatchBody");
      if (body) body.innerHTML = '<div class="empty-hint">无法获取状态</div>';
    }
  }
  function renderExternal(d) {
    const dot = document.getElementById("extBatchDot");
    const body = document.getElementById("extBatchBody");
    const startBtn = document.getElementById("extStartBtn");
    const stopBtn = document.getElementById("extStopBtn");
    if (!dot || !body) return;
    const isRunning = !!d.running;
    dot.className = "ext-batch-dot " + (isRunning ? "up" : "down");
    dot.title = isRunning ? "运行中" : "未运行";
    // 按钮状态：运行中 → 显示停止；未运行 → 显示启动（脚本/venv 缺失时禁用）
    if (startBtn) {
      startBtn.disabled = extBusy || isRunning || d.can_start === false;
      startBtn.style.display = isRunning ? "none" : "";
      startBtn.title = d.can_start === false ? "脚本或 venv python 缺失" : "";
    }
    if (stopBtn) {
      stopBtn.style.display = isRunning ? "" : "none";
      stopBtn.disabled = extBusy || (d.stop_flag && isRunning);
      stopBtn.textContent = (d.stop_flag && isRunning) ? "停止中…" : "停止";
    }
    if (d.error && !d.done) { body.innerHTML = '<div class="empty-hint">' + d.error + "</div>"; return; }
    const pct = d.total ? Math.round(d.done / d.total * 100) : 0;
    const remaining = Math.max(0, d.total - d.done);
    const perImg = d.last_secs && d.last_secs > 5 ? d.last_secs : 95;   // 用日志里的实测单张耗时，缺省 95s
    const etaSec = remaining * perImg;
    const etaStr = etaSec > 3600 ? (etaSec / 3600).toFixed(1) + "小时" : Math.round(etaSec / 60) + "分钟";
    const stateText = (d.stop_flag && isRunning)
      ? '<span class="ext-stopping">已请求停止：当前这张跑完即退出…</span>'
      : (isRunning
        ? (d.current_segment ? "当前：第" + (d.current_seg_num || "?") + "段 · " + d.current_segment + "（第" + d.current_img + "/16张）" : "运行中（准备/排队中…）")
        : "当前没有在跑");
    body.innerHTML = `
      <div class="ext-progress"><div class="ext-progress-bar" style="width:${pct}%"></div></div>
      <div class="ext-stats">
        <span><b>${d.done}</b>/${d.total}（${pct}%）</span>
        <span class="muted">单张约 ${Math.round(perImg)}s · 剩余约 ${etaStr}</span>
      </div>
      <div class="ext-current">${stateText}</div>
      ${d.last_image ? '<div class="ext-last muted">最新：' + d.last_image + '</div>' : ''}
      <div class="ext-actions"><button class="ghost tiny" onclick="window.showPage('gallery')">查看图库</button></div>`;
  }

  async function extStart() {
    if (extBusy) return;
    const p = extParams();
    saveExtParams();
    if (!confirm(`启动外部批量脚本？\n每段 ${p.count} 张 · 从第 ${p.start} 段开始\n已生成的图片会自动跳过（断点续跑），不会重复生成。`)) return;
    extBusy = true;
    try {
      const r = await post("/api/batch/external/start", { count_per: p.count, start_idx: p.start });
      if (!r.ok) alert("启动失败：" + (r.error || "未知错误"));
    } catch (e) { alert("启动失败：" + e); }
    extBusy = false;
    pollExternal();
  }
  async function extStop() {
    if (extBusy) return;
    if (!confirm("请求优雅停止？\n当前这张图片生成完之后退出（不打断当前张）。\n已生成的图片全部保留，之后可从停下的位置继续。")) return;
    extBusy = true;
    try {
      const r = await post("/api/batch/external/stop", {});
      if (!r.ok) alert("停止失败：" + (r.error || "未知错误"));
    } catch (e) { alert("停止失败：" + e); }
    extBusy = false;
    pollExternal();
  }

  // ---------- 初始化 ----------
  loadDraft();
  renderList();
  refreshTasks();
  loadExtParams();
  $("#extStartBtn").addEventListener("click", extStart);
  $("#extStopBtn").addEventListener("click", extStop);
  $("#extCount").addEventListener("change", saveExtParams);
  $("#extStart").addEventListener("change", saveExtParams);
  pollExternal();
  extTimer = setInterval(pollExternal, 5000);
  setInterval(() => refreshTasks(false), 15000);   // 定期刷新任务列表（含未选中的运行中任务）
})();