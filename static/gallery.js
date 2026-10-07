// 图库页面：搜索/收藏/虚拟滚动/多选/删除/4x放大/大图预览
(function () {
  const $ = (s) => document.querySelector(s);
  const enc = encodeURIComponent;
  let currentDir = "";
  let currentPage = 1;
  const pageSize = 48;
  let totalImages = 0;
  let selected = new Set();
  let allImages = []; // 虚拟滚动：所有已加载图片
  let isLoading = false;
  let hasMore = true;
  let loadSeq = 0; // 请求序号：目录/搜索切换时用于作废在途请求，避免旧结果盖回新目录
  let searchQuery = "";
  let onlyFavorites = false;
  let searchTimer = null;

  function imgKey(im) {
    return (im.subfolder ? im.subfolder + "/" : "") + im.filename;
  }
  function viewUrl(im) {
    return `/api/view?filename=${enc(im.filename)}&subfolder=${enc(im.subfolder || "")}&type=${enc(im.type || "output")}`;
  }
  function thumbUrl(im) {
    return `/api/thumb?filename=${enc(im.filename)}&subfolder=${enc(im.subfolder || "")}&type=${enc(im.type || "output")}`;
  }
  function fmtSize(b) {
    if (b < 1024) return b + "B";
    if (b < 1048576) return (b / 1024).toFixed(0) + "KB";
    return (b / 1048576).toFixed(1) + "MB";
  }
  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  // ---------- 瀑布流：每张图按自身比例完整显示，卡片按实际高度跨行 ----------
  // 注意：M_ROW / M_GAP 必须与 style.css 中 .gallery-grid 的 grid-auto-rows / gap 保持一致
  const M_ROW = 6, M_GAP = 10;
  function layoutMasonry(cards) {
    const list = cards || document.querySelectorAll("#galleryGrid .gcard");
    list.forEach((card) => {
      if (!card.isConnected) return;
      const h = card.getBoundingClientRect().height;
      if (!h) return;
      card.style.gridRowEnd = "span " + Math.max(1, Math.ceil((h + M_GAP) / (M_ROW + M_GAP)));
    });
  }
  let masonryResizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(masonryResizeTimer);
    masonryResizeTimer = setTimeout(() => layoutMasonry(), 150);
  });

  // ---------- 缩略图限流加载 ----------
  // 浏览器对同一域名只开放约 6 条连接：一次性发几十个缩略图请求会把连接池占满，
  // 导致"点开大图"的请求排长队（用户实测表现为点开半天不出图）。
  // 这里限制最多 4 个缩略图并发，并只加载进入视口附近的卡片。
  const THUMB_LIMIT = 4;
  let thumbRunning = 0;
  const thumbQueue = [];
  let thumbIO = null;
  function pumpThumbQueue() {
    while (thumbRunning < THUMB_LIMIT && thumbQueue.length) {
      const img = thumbQueue.shift();
      if (!img.isConnected || !img.dataset.src || img.getAttribute("src")) continue;
      thumbRunning++;
      const finish = () => { thumbRunning--; pumpThumbQueue(); };
      const ok = () => { img.removeEventListener("load", ok); img.removeEventListener("error", ok); finish(); };
      img.addEventListener("load", ok);
      img.addEventListener("error", ok);
      img.src = img.dataset.src;
    }
  }
  function observeThumb(card) {
    if (!thumbIO) {
      const grid = $("#galleryGrid");
      thumbIO = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          const img = en.target.querySelector("img.gthumb");
          if (img && img.dataset.src && !img.getAttribute("src")) { thumbQueue.push(img); pumpThumbQueue(); }
          thumbIO.unobserve(en.target);
        });
      }, { root: grid || null, rootMargin: "300px" });
    }
    thumbIO.observe(card);
  }

  async function loadDirs() {
    try {
      const r = await fetch("/api/gallery/dirs");
      const d = await r.json();
      const el = $("#galleryDirs");
      let html = `<div class="gdir ${currentDir === "" ? "active" : ""}" data-dir="">全部 (${d.dirs.reduce((s, x) => s + x.count, 0)})</div>`;
      for (const dir of d.dirs) {
        html += `<div class="gdir ${currentDir === dir.name ? "active" : ""}" data-dir="${dir.name}">
          <span>${dir.name}</span><span class="gdir-count">${dir.count}</span></div>`;
      }
      el.innerHTML = html;
      el.querySelectorAll(".gdir").forEach((b) => {
        b.addEventListener("click", () => {
          currentDir = b.dataset.dir;
          resetAndLoad();
        });
      });
    } catch (e) {
      $("#galleryDirs").innerHTML = '<div class="empty-hint">加载目录失败</div>';
    }
  }

  function resetAndLoad() {
    loadSeq++;           // 作废在途请求
    currentPage = 1;
    allImages = [];
    hasMore = true;
    selected.clear();
    $("#galleryGrid").innerHTML = "";
    isLoading = false;   // 允许立即发起新请求（旧请求返回时会被序号校验丢弃）
    loadImages();
  }

  async function loadImages() {
    if (isLoading || !hasMore) return;
    const mySeq = loadSeq;
    isLoading = true;
    const sentinel = $("#gallerySentinel");
    if (sentinel) {
      sentinel.style.display = "flex";
      const label = sentinel.querySelector("span");
      if (label) label.textContent = (currentPage === 1 && !allImages.length) ? "正在加载图库…" : "加载更多…";
    }
    try {
      const params = new URLSearchParams({
        subfolder: currentDir, page: currentPage, size: pageSize,
      });
      if (searchQuery) params.set("search", searchQuery);
      if (onlyFavorites) params.set("favorites", "1");
      const r = await fetch("/api/gallery/list?" + params.toString());
      const d = await r.json();
      if (mySeq !== loadSeq) return; // 期间目录/搜索已切换：丢弃这份陈旧结果
      totalImages = d.total;
      $("#galleryPath").textContent = currentDir ? currentDir : "全部";
      $("#galleryCount").textContent = `共 ${d.total} 张`;
      if (currentPage === 1 && !d.images.length) {
        $("#galleryGrid").innerHTML = '<div class="empty-hint">暂无图片</div>';
        hasMore = false;
        updateActions();
        return;
      }
      // 追加图片
      const frag = document.createDocumentFragment();
      const newCards = [];
      d.images.forEach((im, idx) => {
        const globalIdx = allImages.length + idx;
        allImages.push(im);
        const card = createCard(im, globalIdx);
        newCards.push(card);
        frag.appendChild(card);
      });
      $("#galleryGrid").appendChild(frag);
      layoutMasonry(newCards);
      hasMore = allImages.length < d.total && d.images.length > 0; // 空页立即停止，避免无限请求
      currentPage++;
    } catch (e) {
      if (mySeq === loadSeq && currentPage === 1) {
        $("#galleryGrid").innerHTML = '<div class="empty-hint">加载失败：' + e.message + "</div>";
      }
    } finally {
      if (mySeq === loadSeq) {
        isLoading = false;
        if (sentinel) {
          sentinel.style.display = hasMore ? "flex" : "none";
          const label = sentinel.querySelector("span");
          if (label) label.textContent = hasMore ? "加载更多…" : "";
        }
        updateActions();
        checkInfinite(); // 内容不足一屏时继续加载下一页
      }
    }
  }

  function createCard(im, globalIdx) {
    const key = imgKey(im);
    const picked = selected.has(key) ? " picked" : "";
    const favClass = im.favorite ? " active" : "";
    const card = document.createElement("div");
    card.className = "gcard" + picked;
    card.dataset.key = key;
    card.dataset.idx = globalIdx;
    const ar = (im.width && im.height) ? (im.width + " / " + im.height) : "2 / 3";
    card.innerHTML = `
      <div class="gpick">✓</div>
      <button class="gfav${favClass}" title="收藏" data-key="${key}">★</button>
      <div class="gthumb-wrap" style="aspect-ratio:${ar}"><img alt="${im.filename}" class="gthumb">
      <div class="gthumb-loader"><div class="spinner"></div></div></div>
      <div class="gmeta"><span class="gname" title="${im.filename}">${im.filename}</span>
      <span>${fmtSize(im.size)} · ${fmtTime(im.mtime)}</span></div>`;
    // 缩略图加载完成/失败：移除遮罩（限流加载，见 observeThumb）
    // 注意：必须在卡片创建时绑定——DocumentFragment 追加到 DOM 后其子节点已移出，之后查询 fragment 会是空的
    const thumbImg = card.querySelector("img.gthumb");
    const thumbWrap = card.querySelector(".gthumb-wrap");
    if (thumbImg && thumbWrap) {
      thumbImg.dataset.src = thumbUrl(im);
      thumbImg.addEventListener("load", () => { thumbWrap.classList.add("loaded"); layoutMasonry([card]); });
      thumbImg.addEventListener("error", () => {
        if (!thumbImg.dataset.retried) {
          // 可能是文件刚写入/暂时不可读：2.5s 后带缓存参数重试一次
          thumbImg.dataset.retried = "1";
          setTimeout(() => { thumbImg.src = thumbImg.dataset.src + "&_r=" + Date.now(); }, 2500);
          return;
        }
        thumbWrap.classList.add("loaded");
        thumbWrap.innerHTML = '<div class="empty-hint" style="padding:20px">加载失败</div>';
        layoutMasonry([card]);
      });
      observeThumb(card);
    }
    // 点击选中
    card.addEventListener("click", (e) => {
      if (e.target.closest("a") || e.target.closest(".gfav")) return;
      if (selected.has(key)) selected.delete(key); else selected.add(key);
      card.classList.toggle("picked");
      updateActions();
    });
    // 点击缩略图打开 lightbox：按卡片 key 定位（不依赖创建时捕获的索引，避免任何错位）
    card.querySelector(".gthumb-wrap").addEventListener("click", (e) => {
      e.stopPropagation();
      openLightbox(card.dataset.key);
    });
    // 星标按钮
    card.querySelector(".gfav").addEventListener("click", async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      try {
        const r = await fetch("/api/favorites/toggle", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        });
        const d = await r.json();
        btn.classList.toggle("active", d.favorite);
        // 更新 allImages 中的 favorite 状态
        const im = allImages[globalIdx];
        if (im) im.favorite = d.favorite;
      } catch (err) { /* ignore */ }
    });
    return card;
  }

  function updateActions() {
    const n = selected.size;
    $("#galleryUpscale").disabled = n === 0;
    $("#galleryDelete").disabled = n === 0;
    $("#galleryUpscale").textContent = n ? `放大选中 ${n} 张（4x）` : "放大选中（4x）";
    $("#galleryDelete").textContent = n ? `删除选中 ${n} 张` : "删除选中";
    const compareBtn = $("#galleryCompare");
    if (compareBtn) {
      compareBtn.disabled = n !== 2;
      compareBtn.textContent = n === 2 ? "对比选中 2 张" : "对比（需选2张）";
    }
  }

  function getSelectedImages() {
    const cards = document.querySelectorAll("#galleryGrid .gcard.picked");
    const result = [];
    cards.forEach((card) => {
      const key = card.dataset.key;
      const parts = key.split("/");
      const filename = parts.pop();
      const subfolder = parts.join("/");
      result.push({ filename, subfolder, type: "output" });
    });
    return result;
  }

  async function upscaleSelected() {
    const imgs = getSelectedImages();
    if (!imgs.length) return;
    if (!confirm(`确定对 ${imgs.length} 张图片进行 4x 放大？\n放大后的图片会保存到 upscale-4x/ 目录。`)) return;
    const btn = $("#galleryUpscale");
    btn.disabled = true;
    btn.textContent = "放大中…";
    let ok = 0, fail = 0;
    for (const im of imgs) {
      try {
        const r = await fetch("/api/gallery/upscale", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(im),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        await pollHistory(d.prompt_id);
        ok++;
      } catch (e) { fail++; }
      btn.textContent = `放大中 ${ok + fail}/${imgs.length}…`;
    }
    btn.textContent = `放大完成 ${ok} 成功${fail ? "，" + fail + " 失败" : ""}`;
    setTimeout(() => { updateActions(); }, 2000);
  }

  async function pollHistory(pid) {
    // 4x 放大可能排在外部批量后面（单张几分钟），超时给足 30 分钟，避免误报失败
    const deadline = Date.now() + 1800000;
    while (Date.now() < deadline) {
      const r = await fetch("/api/history?id=" + enc(pid));
      const d = await r.json();
      if (d.done) {
        if (d.status_str === "error") throw new Error("放大出错");
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error("等待超时（>30 分钟，可能一直在排队）");
  }

  async function deleteSelected() {
    const imgs = getSelectedImages();
    if (!imgs.length) return;
    if (!confirm(`确定删除 ${imgs.length} 张图片？\n此操作不可恢复！`)) return;
    try {
      const r = await fetch("/api/gallery/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: imgs }),
      });
      const d = await r.json();
      selected.clear();
      resetAndLoad();
      loadDirs();
      alert(`删除完成：${d.deleted} 张成功，${d.failed} 张失败`);
    } catch (e) {
      alert("删除失败：" + e.message);
    }
  }

  function selectAll() {
    const cards = document.querySelectorAll("#galleryGrid .gcard");
    const allPicked = cards.length && [...cards].every((c) => c.classList.contains("picked"));
    cards.forEach((c) => {
      const key = c.dataset.key;
      if (allPicked) { selected.delete(key); c.classList.remove("picked"); }
      else { selected.add(key); c.classList.add("picked"); }
    });
    $("#gallerySelectAll").textContent = allPicked ? "全选" : "取消全选";
    updateActions();
  }

  // ---------- Lightbox ----------
  let lightboxIdx = 0;
  let lbLoadSeq = 0;      // 作废在途的图片加载重试
  let lbPromptSeq = 0;    // 作废在途的提示词请求
  let lbFullPrompt = "";  // 当前大图的完整提示词（供「生成变体」复用）
  // 1x1 透明 GIF：切换图片时先把画面清空，避免加载期间仍显示上一张
  const BLANK_IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  /* ---------- 缩放 / 拖动（按 panzoom / medium-zoom / zoooom 的标准做法重写） ----------
     坐标系：图片在 stage 内居中，transform: translate3d(tx,ty,0) scale(s)，原点为图片中心。
     屏幕点 p 与图片内坐标 u 的关系：p = C + t + s·u（C 为 stage 中心）
     ⇒ 围绕指针缩放（指针下的像素保持不动）：t' = v·(1−r) + r·t，v = 指针 − C，r = s'/s
     拖动：指针位移直接加到 t 上；并用边界钳制保证图片不会被拖出可视区。 */
  const LB_MIN = 0.5, LB_MAX = 8;
  const lb = { s: 1, tx: 0, ty: 0, base: null };

  function lbStage() { return document.querySelector(".lightbox-stage"); }

  // 记录 1:1 时的显示尺寸作为缩放基准
  function lbMeasureBase() {
    const img = $("#lightboxImg");
    if (!img || !img.naturalWidth) return;
    img.style.transform = "";
    const r = img.getBoundingClientRect();
    lb.base = { w: r.width, h: r.height };
  }

  // 边界钳制：图片大于视口时不允许把边缘拖进视口内；小于视口时强制居中。
  // 放大状态下额外给 15% 过界余量（类似 panzoom 的 boundsPadding）：
  // 否则竖图在宽舞台上会因为"比舞台窄"而被强制居中，围绕指针缩放会失去横向锚点。
  function lbClamp() {
    const st = lbStage();
    if (!st || !lb.base) return;
    const sw = lb.base.w * lb.s, sh = lb.base.h * lb.s;
    const allowX = lb.s > 1.001 ? st.clientWidth * 0.15 : 0;
    const allowY = lb.s > 1.001 ? st.clientHeight * 0.15 : 0;
    const maxX = Math.max(0, (sw - st.clientWidth) / 2) + allowX;
    const maxY = Math.max(0, (sh - st.clientHeight) / 2) + allowY;
    lb.tx = Math.min(maxX, Math.max(-maxX, lb.tx));
    lb.ty = Math.min(maxY, Math.max(-maxY, lb.ty));
    if (lb.s <= 1.001) { lb.tx = 0; lb.ty = 0; } // 回到 1:1 即居中
  }

  function lbApply() {
    const img = $("#lightboxImg");
    if (!img) return;
    img.style.transform = `translate3d(${lb.tx}px, ${lb.ty}px, 0) scale(${lb.s})`;
    const st = lbStage();
    if (st) st.classList.toggle("zoomed", lb.s > 1.001);
  }

  function lbZoomAt(vx, vy, factor) {
    const s2 = Math.max(LB_MIN, Math.min(LB_MAX, lb.s * factor));
    const r = s2 / lb.s;
    lb.tx = vx * (1 - r) + r * lb.tx;
    lb.ty = vy * (1 - r) + r * lb.ty;
    lb.s = s2;
    lbClamp();
    lbApply();
  }

  function lbZoomCenter(factor) { lbZoomAt(0, 0, factor); }
  function lbReset() { lb.s = 1; lb.tx = 0; lb.ty = 0; lbClamp(); lbApply(); }

  // 指针 → 相对 stage 中心的偏移
  function lbOffset(e, st) {
    const r = st.getBoundingClientRect();
    return { x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
  }

  // 打开大图：参数可以是 allImages 的下标（上一张/下一张）或卡片 key（点击缩略图）
  function openLightbox(keyOrIdx) {
    const idx = (typeof keyOrIdx === "number")
      ? keyOrIdx
      : allImages.findIndex((im) => imgKey(im) === keyOrIdx);
    if (idx < 0) return;
    lightboxIdx = idx;
    showLightboxImage();
    $("#lightbox").style.display = "flex";
  }

  function showLightboxImage() {
    const im = allImages[lightboxIdx];
    if (!im) return;
    const img = $("#lightboxImg");
    const loader = $("#lightboxLoader");
    loader.style.display = "flex";
    loader.innerHTML = '<div class="spinner"></div>';
    // 立刻清空上一张的画面（先指向 1x1 透明图），加载新图期间只会看到加载动画
    img.onload = null;
    img.onerror = null;
    img.src = BLANK_IMG;
    img.style.opacity = "0";
    img.style.transform = "";
    lb.s = 1; lb.tx = 0; lb.ty = 0; lb.base = null;
    const mySeq = ++lbLoadSeq;
    let attempt = 0;
    const tryLoad = () => {
      if (mySeq !== lbLoadSeq) return;
      img.onload = () => {
        if (mySeq !== lbLoadSeq) return;
        loader.style.display = "none";
        img.style.opacity = "1";
        lbMeasureBase(); // 记录 1:1 显示尺寸作为缩放基准
        lbApply();
      };
      img.onerror = () => {
        if (mySeq !== lbLoadSeq) return;
        attempt++;
        if (attempt < 3) {
          loader.innerHTML = '<div class="empty-hint" style="color:#ddd">加载失败，正在重试…</div>';
          setTimeout(() => { if (mySeq === lbLoadSeq) tryLoad(); }, 2500);
        } else {
          loader.innerHTML = '<div class="empty-hint" style="color:#ddd">图片加载失败（文件可能仍在写入），可关闭后稍后再试</div>';
        }
      };
      img.src = viewUrl(im) + (attempt ? "&_r=" + Date.now() : "");
    };
    tryLoad();
    $("#lightboxInfo").innerHTML = `
      <div class="lb-count">${lightboxIdx + 1} / ${allImages.length}${totalImages > allImages.length ? "（已加载 " + allImages.length + "/" + totalImages + "）" : ""}</div>
      <div class="lb-name">${im.filename}</div>
      <div class="muted">${fmtSize(im.size)} · ${fmtTime(im.mtime)} · 滚轮缩放 · 放大后可拖动 · 双击放大/还原</div>
      <div class="lb-actions">
        <button class="ghost small" id="lbPrev">← 上一张</button>
        <button class="ghost small" id="lbZoomOut">－</button>
        <button class="ghost small" id="lbZoomReset">1:1</button>
        <button class="ghost small" id="lbZoomIn">＋</button>
        <button class="ghost small" id="lbNext">下一张 →</button>
        <button class="ghost small" id="lbFav">${im.favorite ? "★ 已收藏" : "☆ 收藏"}</button>
        <button class="ghost small" id="lbVariant">生成变体</button>
        <button class="ghost small" id="lbFace">＋人脸库</button>
        <button class="ghost small" id="lbOutfit">＋服饰库</button>
        <a href="${viewUrl(im)}" download="${im.filename}" class="ghost small">下载</a>
      </div>
      <div class="lb-prompt-wrap">
        <div class="lb-prompt-label">完整提示词</div>
        <div class="lb-prompt" id="lbPrompt"></div>
      </div>`;
    // 列表接口的 prompt 被截断到 120 字，这里异步取全量并展示
    const promptEl = $("#lbPrompt");
    lbFullPrompt = im.prompt || "";
    if (promptEl) promptEl.textContent = lbFullPrompt ? lbFullPrompt + "…" : "读取中…";
    const myPS = ++lbPromptSeq;
    fetch("/api/prompt?filename=" + enc(im.filename) + "&subfolder=" + enc(im.subfolder || "") + "&type=" + enc(im.type || "output"))
      .then((r) => r.json())
      .then((d) => {
        if (myPS !== lbPromptSeq || !promptEl) return;
        if (d.prompt) { lbFullPrompt = d.prompt; promptEl.textContent = d.prompt; }
        else if (!lbFullPrompt) promptEl.textContent = "（这张图没有内嵌提示词）";
      })
      .catch(() => { if (myPS === lbPromptSeq && promptEl && !lbFullPrompt) promptEl.textContent = "（提示词读取失败）"; });
    $("#lbPrev").addEventListener("click", (e) => { e.stopPropagation(); navLightbox(-1); });
    $("#lbNext").addEventListener("click", (e) => { e.stopPropagation(); navLightbox(1); });
    $("#lbZoomIn").addEventListener("click", (e) => { e.stopPropagation(); lbZoomCenter(1.35); });
    $("#lbZoomOut").addEventListener("click", (e) => { e.stopPropagation(); lbZoomCenter(1 / 1.35); });
    $("#lbZoomReset").addEventListener("click", (e) => { e.stopPropagation(); lbReset(); });
    $("#lbFav").addEventListener("click", async (e) => {
      e.stopPropagation();
      const key = imgKey(im);
      try {
        const r = await fetch("/api/favorites/toggle", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        });
        const d = await r.json();
        im.favorite = d.favorite;
        e.currentTarget.textContent = d.favorite ? "★ 已收藏" : "☆ 收藏";
        // 同步更新网格中的星标
        const card = document.querySelector(`.gcard[data-key="${CSS.escape(key)}"]`);
        if (card) {
          const btn = card.querySelector(".gfav");
          if (btn) btn.classList.toggle("active", d.favorite);
        }
      } catch (err) { /* ignore */ }
    });
    const vb = $("#lbVariant");
    if (vb) vb.addEventListener("click", async (e) => {
      e.stopPropagation();
      let seed = null;
      const m = (im.filename || "").match(/_s(\d+)/);
      if (m) seed = m[1];
      if (!window.useImageVariant) { alert("控制台未加载 useImageVariant 函数"); return; }
      // 直接复用大图底部已取到的完整提示词（列表里的 prompt 被截断到 120 字）
      let promptText = lbFullPrompt || "";
      if (!promptText) {
        try {
          const r = await fetch("/api/prompt?filename=" + enc(im.filename) + "&subfolder=" + enc(im.subfolder || "") + "&type=" + enc(im.type || "output"));
          const d = await r.json();
          if (d.prompt) promptText = d.prompt;
        } catch (err) { /* 取不到就用截断版 */ }
      }
      window.useImageVariant(promptText, seed, im.filename);
    });
    const fb = $("#lbFace");
    if (fb) fb.addEventListener("click", (e) => { e.stopPropagation(); addToLibrary("faces", im, fb); });
    const ob = $("#lbOutfit");
    if (ob) ob.addEventListener("click", (e) => { e.stopPropagation(); addToLibrary("outfits", im, ob); });
  }

  // 从图库加入人脸库 / 服饰库（复用后端 /api/faces/add、/api/outfits/add）
  async function addToLibrary(kind, im, btn) {
    const label = kind === "faces" ? "人脸" : "服饰";
    const name = prompt(`加入${label}库，名称：`, (im.filename || "").replace(/\.[^.]+$/, ""));
    if (name === null) return;
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "加入中…";
    try {
      const r = await fetch(`/api/${kind}/add`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: im.filename, subfolder: im.subfolder || "", name: name, tags: [] }),
      });
      const d = await r.json();
      if (d.ok) {
        btn.textContent = "已加入" + label + "库";
      } else {
        btn.disabled = false;
        btn.textContent = original;
        alert("加入失败：" + (d.error || "未知错误"));
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = original;
      alert("加入失败：" + err.message);
    }
  }

  // ---------- 交互绑定：滚轮缩放 / 拖动 / 双击 / 触屏双指 ----------
  (function bindViewer() {
    const st = lbStage();
    if (!st) return;
    const hidden = () => $("#lightbox").style.display === "none";

    // 滚轮：围绕指针缩放（指数步进，兼容触控板连续滚动）
    st.addEventListener("wheel", (e) => {
      if (hidden()) return;
      e.preventDefault();
      const v = lbOffset(e, st);
      lbZoomAt(v.x, v.y, Math.exp(-e.deltaY * 0.0018));
    }, { passive: false });

    // 指针拖动（pointer capture：拖到窗口外也不会中断）
    let drag = null;              // {id, x, y, tx, ty}
    const pointers = new Map();   // 触屏多指
    let pinch = null;             // {dist, mx, my}

    st.addEventListener("pointerdown", (e) => {
      if (hidden()) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        drag = null;
        st.classList.remove("dragging");
        return;
      }
      if (lb.s <= 1.001) return;                    // 1:1 时不拖动（保持居中）
      if (e.pointerType === "mouse" && e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx: lb.tx, ty: lb.ty };
      try { st.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      st.classList.add("dragging");
    });

    st.addEventListener("pointermove", (e) => {
      if (hidden()) return;
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // 双指缩放：跟随两指中点与间距
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (pinch.dist > 0 && dist > 0) {
          const v = lbOffset({ clientX: mx, clientY: my }, st);
          lbZoomAt(v.x, v.y, dist / pinch.dist);
          lb.tx += mx - pinch.mx;                  // 同时跟随中点平移
          lb.ty += my - pinch.my;
          lbClamp();
          lbApply();
        }
        pinch = { dist, mx, my };
        return;
      }
      if (!drag || e.pointerId !== drag.id) return;
      lb.tx = drag.tx + (e.clientX - drag.x);
      lb.ty = drag.ty + (e.clientY - drag.y);
      lbClamp();
      lbApply();
    });

    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && e.pointerId === drag.id) {
        drag = null;
        st.classList.remove("dragging");
        try { st.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
    };
    st.addEventListener("pointerup", endPointer);
    st.addEventListener("pointercancel", endPointer);

    // 双击：在指针处放大 / 再次双击回到 1:1
    st.addEventListener("dblclick", (e) => {
      if (hidden()) return;
      e.preventDefault();
      if (lb.s > 1.001) { lbReset(); return; }
      const v = lbOffset(e, st);
      lbZoomAt(v.x, v.y, 2.5);
    });

    // 窗口尺寸变化后重新测量基准并复位（避免缩放基准与布局不一致）
    window.addEventListener("resize", () => {
      if (hidden()) return;
      lbMeasureBase();
      lbReset();
    });
  })();

  function navLightbox(dir) {
    lightboxIdx = (lightboxIdx + dir + allImages.length) % allImages.length;
    showLightboxImage();
  }

  function closeLightbox() { $("#lightbox").style.display = "none"; }

  // ---------- 无限滚动 ----------
  // 注意：#galleryGrid 自身是滚动容器（overflow-y:auto），哨兵元素在网格之外、
  // 始终处于视口内不发生变化，用 IntersectionObserver 只会在初始化时触发一次，
  // 导致第 2 页起永远不加载（已实测复现）。这里改为监听网格真实滚动 + 每次加载后自检。
  function checkInfinite() {
    if (isLoading || !hasMore) return;
    const g = $("#galleryGrid");
    if (!g) return;
    // 内容不足一屏，或已滚动到接近底部 → 加载下一页
    if (g.scrollHeight <= g.clientHeight + 20 || g.scrollTop + g.clientHeight >= g.scrollHeight - 300) {
      loadImages();
    }
  }

  // ---------- 绑定 ----------
  $("#galleryRefresh").addEventListener("click", () => { loadDirs(); resetAndLoad(); });
  $("#gallerySelectAll").addEventListener("click", selectAll);
  $("#galleryUpscale").addEventListener("click", upscaleSelected);
  $("#galleryDelete").addEventListener("click", deleteSelected);
  $("#lightboxClose").addEventListener("click", closeLightbox);
  $("#lightboxBg").addEventListener("click", closeLightbox);

  // 搜索框
  const searchInput = $("#gallerySearch");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      // 500ms 防抖：搜索要对全量图片做提示词匹配，避免每敲一个字就发起一次全量扫描
      searchTimer = setTimeout(() => {
        searchQuery = e.target.value.trim();
        resetAndLoad();
      }, 500);
    });
  }

  // 只看收藏按钮
  const favBtn = $("#galleryFavFilter");
  if (favBtn) {
    favBtn.addEventListener("click", () => {
      onlyFavorites = !onlyFavorites;
      favBtn.classList.toggle("active", onlyFavorites);
      favBtn.textContent = onlyFavorites ? "★ 只看收藏" : "☆ 只看收藏";
      resetAndLoad();
    });
  }

  document.addEventListener("keydown", (e) => {
    if ($("#lightbox").style.display === "none") return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") navLightbox(-1);
    if (e.key === "ArrowRight") navLightbox(1);
    if (e.key === "+" || e.key === "=") lbZoomCenter(1.35);
    if (e.key === "-") lbZoomCenter(1 / 1.35);
    if (e.key === "0") lbReset();
  });

  window.galleryRefresh = function () { loadDirs(); resetAndLoad(); };

  // ---------- 对比视图 ----------
  let compareImages = [];
  function openCompare() {
    if (selected.size !== 2) return;
    const keys = Array.from(selected);
    compareImages = keys.map(function(key) {
      return allImages.find(function(im) { return imgKey(im) === key; });
    }).filter(Boolean);
    if (compareImages.length !== 2) return;
    $("#compareImgLeft").src = viewUrl(compareImages[0]);
    $("#compareImgRight").src = viewUrl(compareImages[1]);
    $("#compareLabelLeft").textContent = compareImages[0].filename.substring(0, 30);
    $("#compareLabelRight").textContent = compareImages[1].filename.substring(0, 30);
    $("#compareView").style.display = "flex";
    // 重置滑块位置
    setCompareSlider(50);
  }

  function setCompareSlider(pct) {
    pct = Math.max(0, Math.min(100, pct));
    const slider = $("#compareSlider");
    const rightWrap = $("#compareRightWrap");
    if (slider) slider.style.left = pct + "%";
    if (rightWrap) rightWrap.style.clipPath = "inset(0 0 0 " + pct + "%)";
  }

  function initCompareDrag() {
    const container = $("#compareContainer");
    if (!container) return;
    let dragging = false;
    function onMove(e) {
      if (!dragging) return;
      const rect = container.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const pct = ((clientX - rect.left) / rect.width) * 100;
      setCompareSlider(pct);
    }
    container.addEventListener("mousedown", function(e) { dragging = true; onMove(e); });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", function() { dragging = false; });
    container.addEventListener("touchstart", function(e) { dragging = true; onMove(e); }, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", function() { dragging = false; });
  }

  function closeCompare() { $("#compareView").style.display = "none"; }

  const compareBtn = $("#galleryCompare");
  if (compareBtn) compareBtn.addEventListener("click", openCompare);
  $("#compareClose").addEventListener("click", closeCompare);
  $("#compareBg").addEventListener("click", closeCompare);
  document.addEventListener("keydown", function(e) {
    if ($("#compareView").style.display === "none") return;
    if (e.key === "Escape") closeCompare();
  });
  initCompareDrag();

  // 自启动
  loadDirs();
  const gridEl = $("#galleryGrid");
  if (gridEl) gridEl.addEventListener("scroll", checkInfinite, { passive: true });
})();
