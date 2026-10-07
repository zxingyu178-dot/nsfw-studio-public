// 顶部导航切换
(function () {
  const tabs = document.querySelectorAll("#mainTabs [data-page]");
  const pages = document.querySelectorAll(".page");

  function showPage(id) {
    pages.forEach((p) => {
      p.style.display = p.id === "page-" + id ? "" : "none";
    });
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.page === id));
    // 页面切换时触发刷新
    if (id === "gencenter" && window.gencenterRefresh) window.gencenterRefresh();
    if (id === "gallery" && window.galleryRefresh) window.galleryRefresh();
    if (id === "batch" && window.batchRefresh) window.batchRefresh();
    if (id === "promptlib" && window.promptlibRefresh) window.promptlibRefresh();
    if (id === "faces" && window.facesRefresh) window.facesRefresh();
    if (id === "outfits" && window.outfitsRefresh) window.outfitsRefresh();
  }

  // 暴露给其他页面调用（如从图库跳转到控制台）
  window.showPage = showPage;

  tabs.forEach((t) => {
    t.addEventListener("click", () => showPage(t.dataset.page));
  });

  // 默认显示生成中心（统一生成入口）
  showPage("gencenter");
})();
