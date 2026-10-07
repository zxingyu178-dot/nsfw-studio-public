// 人脸库页面：浏览/选用/重命名/删除/上传
(function () {
  const $ = (s) => document.querySelector(s);
  let faces = [];

  function faceThumbUrl(face) {
    // characters 目录在 ComfyUI input 下，用 /api/view?type=input
    const parts = face.filename.split("/");
    const sub = parts.slice(0, -1).join("/");
    const fn = parts[parts.length - 1];
    return `/api/view?filename=${encodeURIComponent(fn)}&subfolder=${encodeURIComponent(sub)}&type=input`;
  }

  async function load() {
    try {
      const r = await fetch("/api/faces/list");
      const d = await r.json();
      faces = d.faces || [];
      render();
    } catch (e) {
      $("#facesGrid").innerHTML = '<div class="empty-hint">加载失败：' + e.message + "</div>";
    }
  }

  function render() {
    const grid = $("#facesGrid");
    if (!faces.length) {
      grid.innerHTML = '<div class="empty-hint">还没有人脸。从图库收藏或上传一张清晰正面照</div>';
      return;
    }
    grid.innerHTML = faces.map((f) => `
      <div class="face-card" data-id="${f.id}">
        <div class="face-img-wrap"><img src="${faceThumbUrl(f)}" alt="${f.name}" loading="lazy"></div>
        <div class="face-name" title="${f.name}">${f.name}</div>
        <div class="face-tags">${(f.tags || []).map(t => `<span class="tag">${t}</span>`).join("")}</div>
        <div class="face-meta muted">使用 ${f.use_count || 0} 次</div>
        <div class="face-actions">
          <button class="primary tiny" data-act="use">选用</button>
          <button class="ghost tiny" data-act="rename">改名</button>
          <button class="danger tiny" data-act="del">删除</button>
        </div>
      </div>
    `).join("");

    grid.querySelectorAll(".face-card").forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('[data-act=use]').addEventListener("click", () => useFace(id));
      card.querySelector('[data-act=rename]').addEventListener("click", () => renameFace(id));
      card.querySelector('[data-act=del]').addEventListener("click", () => deleteFace(id));
    });
  }

  async function useFace(id) {
    const f = faces.find(x => x.id === id);
    if (!f) return;
    // 通知控制台设置 lock_image
    if (window.setLockFace) {
      window.setLockFace(f.filename, f.name);
    } else {
      // 回退：存到 localStorage，控制台读取
      localStorage.setItem("nsfw_lock_face", JSON.stringify({ path: f.filename, name: f.name }));
    }
    // use_count +1
    try { await fetch("/api/faces/use", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id }) }); } catch(e) {}
    // 切到控制台
    document.querySelector('[data-page="console"]').click();
  }

  async function renameFace(id) {
    const f = faces.find(x => x.id === id);
    if (!f) return;
    const name = prompt("名称", f.name);
    if (name === null) return;
    const tagsStr = prompt("标签（逗号分隔）", (f.tags || []).join(", "));
    if (tagsStr === null) return;
    const tags = tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean);
    try {
      await fetch("/api/faces/rename", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ id, name, tags })
      });
      load();
    } catch (e) { alert("重命名失败：" + e.message); }
  }

  async function deleteFace(id) {
    const f = faces.find(x => x.id === id);
    if (!f) return;
    if (!confirm(`删除人脸「${f.name}」？`)) return;
    try {
      await fetch("/api/faces/delete", {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ id })
      });
      load();
    } catch (e) { alert("删除失败：" + e.message); }
  }

  // 上传
  async function uploadFace(file) {
    const name = prompt("给这张脸起个名字", file.name.replace(/\.[^.]+$/, ""));
    if (name === null) return;
    const reader = new FileReader();
    reader.onload = async function() {
      try {
        const r = await fetch("/api/faces/upload", {
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

  // 绑定
  $("#facesRefreshBtn").addEventListener("click", load);
  $("#facesUploadBtn").addEventListener("click", () => $("#facesUploadFile").click());
  $("#facesUploadFile").addEventListener("change", (e) => {
    if (e.target.files[0]) uploadFace(e.target.files[0]);
    e.target.value = "";
  });

  window.facesRefresh = load;
})();
