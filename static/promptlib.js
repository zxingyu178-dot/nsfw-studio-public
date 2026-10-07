// 提示词库页面：列表/新建/编辑/删除/导入/导出/加载到控制台
(function () {
  const $ = (s) => document.querySelector(s);
  let items = [];
  let editingId = null;

  async function load() {
    try {
      const r = await fetch("/api/promptlib/list");
      const d = await r.json();
      items = d.items || [];
      render();
    } catch (e) {
      $("#promptlibList").innerHTML = '<div class="empty-hint">加载失败：' + e.message + "</div>";
    }
  }

  function render() {
    const el = $("#promptlibList");
    if (!items.length) {
      el.innerHTML = '<div class="empty-hint">提示词库为空。点击「新建」或「从目录批量导入」开始。</div>';
      return;
    }
    el.innerHTML = items.map((it, idx) => `
      <div class="plitem" data-id="${it.id}">
        <div class="plitem-head">
          <span class="plitem-idx">${idx + 1}</span>
          <span class="plitem-name">${it.name || "(未命名)"}</span>
          ${it.category ? `<span class="plitem-cat">${it.category}</span>` : ""}
          <span class="plitem-len muted">${(it.positive || "").length}字</span>
          <div class="plitem-actions">
            <button class="ghost tiny" data-act="load">加载到控制台</button>
            <button class="ghost tiny" data-act="edit">编辑</button>
            <button class="danger tiny" data-act="del">删除</button>
          </div>
        </div>
        <div class="plitem-preview">${(it.positive || "").substring(0, 200)}${(it.positive || "").length > 200 ? "…" : ""}</div>
        ${it.negative ? `<div class="plitem-neg"><b>负面：</b>${it.negative.substring(0, 100)}${it.negative.length > 100 ? "…" : ""}</div>` : ""}
      </div>
    `).join("");
    el.querySelectorAll(".plitem").forEach((card) => {
      const id = card.dataset.id;
      card.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const act = btn.dataset.act;
          const it = items.find((x) => x.id === id);
          if (!it) return;
          if (act === "edit") openModal(it);
          else if (act === "del") {
            if (confirm(`删除「${it.name}」？`)) {
              items = items.filter((x) => x.id !== id);
              save();
            }
          } else if (act === "load") {
            loadToConsole(it);
          }
        });
      });
    });
  }

  function loadToConsole(it) {
    // 切换到控制台页面，填入提示词
    document.querySelector('#mainTabs [data-page="console"]').click();
    setTimeout(() => {
      const pos = document.getElementById("positive");
      const neg = document.getElementById("negative");
      if (pos) pos.value = it.positive || "";
      if (neg) neg.value = it.negative || "";
      alert(`已加载「${it.name}」到控制台。\n注意：改动左侧任何选项都会用实时编译结果覆盖它。`);
    }, 100);
  }

  function openModal(it) {
    editingId = it ? it.id : null;
    $("#plModalTitle").textContent = it ? "编辑提示词" : "新建提示词";
    $("#plName").value = it ? (it.name || "") : "";
    $("#plCategory").value = it ? (it.category || "") : "";
    $("#plPositive").value = it ? (it.positive || "") : "";
    $("#plNegative").value = it ? (it.negative || "") : "";
    $("#plModal").style.display = "flex";
  }

  function closeModal() {
    $("#plModal").style.display = "none";
    editingId = null;
  }

  async function saveModal() {
    const name = $("#plName").value.trim();
    const positive = $("#plPositive").value.trim();
    if (!name) { alert("请输入名称"); return; }
    if (!positive) { alert("请输入正面提示词"); return; }
    const data = {
      name,
      category: $("#plCategory").value.trim(),
      positive,
      negative: $("#plNegative").value.trim(),
    };
    if (editingId) {
      const it = items.find((x) => x.id === editingId);
      if (it) Object.assign(it, data);
    } else {
      data.id = "pl_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 6);
      items.push(data);
    }
    await save();
    closeModal();
  }

  async function save() {
    try {
      await fetch("/api/promptlib/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      render();
    } catch (e) {
      alert("保存失败：" + e.message);
    }
  }

  async function importFromDir() {
    const dir = prompt("输入提示词 .txt 文件所在目录的绝对路径：\n\n例如：D:\\AIHome_2.0_L1_L2\\projects\\comfyui\\temp\\prompts20",
      "D:\\AIHome_2.0_L1_L2\\projects\\comfyui\\temp\\prompts20");
    if (!dir) return;
    try {
      const r = await fetch("/api/promptlib/import_dir", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir }),
      });
      const d = await r.json();
      if (d.error) { alert(d.error); return; }
      if (!d.imported) { alert("未找到可导入的 .txt 文件"); return; }
      // 合并去重（按 id/name）
      const existing = new Set(items.map((x) => x.id));
      for (const it of d.items) {
        if (!existing.has(it.id)) {
          items.push(it);
          existing.add(it.id);
        }
      }
      await save();
      alert(`成功导入 ${d.imported} 段提示词`);
    } catch (e) {
      alert("导入失败：" + e.message);
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "promptlib_" + new Date().toISOString().substring(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- 绑定 ----------
  $("#plAddBtn").addEventListener("click", () => openModal(null));
  $("#plImportBtn").addEventListener("click", importFromDir);
  $("#plExportBtn").addEventListener("click", exportJson);
  $("#plSaveBtn").addEventListener("click", saveModal);
  $("#plCancelBtn").addEventListener("click", closeModal);
  $("#plModalBg").addEventListener("click", closeModal);

  // 暴露给 nav.js
  window.promptlibRefresh = function () { load(); };
})();
