// 服饰库页面：浏览/选用/重命名/删除/上传
(function () {
  const $ = (s) => document.querySelector(s);
  let outfits = [];

  function outfitThumbUrl(o) {
    const parts = o.filename.split("/");
    const sub = parts.slice(0, -1).join("/");
    const fn = parts[parts.length - 1];
    return `/api/view?filename=${encodeURIComponent(fn)}&subfolder=${encodeURIComponent(sub)}&type=input`;
  }

  async function load() {
    try {
      const r = await fetch("/api/outfits/list");
      const d = await r.json();
      outfits = d.outfits || [];
      render();
    } catch (e) {
      $("#outfitsGrid").innerHTML = '<div class="empty-hint">加载失败：' + e.message + "</div>";
    }
  }

  function render() {
    const grid = $("#outfitsGrid");
    if (!outfits.length) {
      grid.innerHTML = '<div class="empty-hint">还没有服饰参考图。上传一张穿着目标服饰的图</div>';
      return;
    }
    grid.innerHTML = outfits.map((o) => `
      <div class="face-card" data-id="${o.id}">
        <div class="face-img-wrap"><img src="${outfitThumbUrl(o)}" alt="${o.name}" loading="lazy"></div>
        <div class="face-name" title="${o.name}">${o.name}</div>
        <div class="face-tags">${(o.tags || []).map(t => `<span class="tag">${t}</span>`).join("")}</div>
        <div class="face-meta muted">使用 ${o.use_count || 0} 次</div>
        <div class="face-actions">
          <button class="primary tiny" data-act="use">选用</button>
          <button class="ghost tiny" data-act="rename">改名</button>
          <button class="danger tiny" data-act="del">删除</button>
        </div>
      </div>
    `).join("");

    grid.querySelectorAll(".face-card").forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('[data-act=use]').addEventListener("click", () => useOutfit(id));
      card.querySelector('[data-act=rename]').addEventListener("click", () => renameOutfit(id));
      card.querySelector('[data-act=del]').addEventListener("click", () => deleteOutfit(id));
    });
  }

  async function useOutfit(id) {
    const o = outfits.find(x => x.id === id);
    if (!o) return;
    if (window.setOutfitRef) {
      window.setOutfitRef(o.filename, o.name);
    }
    try { await fetch("/api/outfits/use", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id }) }); } catch(e) {}
    document.querySelector('[data-page="console"]').click();
  }

  async function renameOutfit(id) {
    const o = outfits.find(x => x.id === id);
    if (!o) return;
    const name = prompt("名称", o.name);
    if (name === null) return;
    const tagsStr = prompt("标签（逗号分隔）", (o.tags || []).join(", "));
    if (tagsStr === null) return;
    const tags = tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean);
    try {
      await fetch("/api/outfits/rename", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ id, name, tags })
      });
      load();
    } catch (e) { alert("重命名失败：" + e.message); }
  }

  async function deleteOutfit(id) {
    const o = outfits.find(x => x.id === id);
    if (!o) return;
    if (!confirm(`删除服饰「${o.name}」？`)) return;
    try {
      await fetch("/api/outfits/delete", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ id })
      });
      load();
    } catch (e) { alert("删除失败：" + e.message); }
  }

  async function uploadOutfit(file) {
    const name = prompt("给这套服饰起个名字", file.name.replace(/\.[^.]+$/, ""));
    if (name === null) return;
    const reader = new FileReader();
    reader.onload = async function() {
      try {
        const r = await fetch("/api/outfits/upload", {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ image: reader.result, name, tags: [] })
        });
        const d = await r.json();
        if (d.error) alert(d.error);
        else load();
      } catch (e) { alert("上传失败：" + e.message); }
    };
    reader.readAsDataURL(file);
  }

  $("#outfitsRefreshBtn").addEventListener("click", load);
  $("#outfitsUploadBtn").addEventListener("click", () => $("#outfitsUploadFile").click());
  $("#outfitsUploadFile").addEventListener("change", (e) => {
    if (e.target.files[0]) uploadOutfit(e.target.files[0]);
    e.target.value = "";
  });

  window.outfitsRefresh = load;
})();
