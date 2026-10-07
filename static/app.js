// NSFW Studio 前端逻辑（分板块 · 手风琴 · 联动去矛盾 · 细化版）

const SECTIONS = [
  { id: "face", label: "容貌", groups: ["facePreset", "style", "count", "ethnicity", "age"] },
  { id: "facial", label: "脸部", groups: ["faceShape", "eyes", "nose", "lips", "skin", "makeup", "faceDetails"] },
  { id: "body", label: "身材", groups: ["height", "frame", "body", "bodyDetails", "breastShape", "nippleType", "breastDetails"] },
  { id: "outfit", label: "服装", groups: ["outfit", "color", "fit", "underwear", "shoes", "accessories"] },
  { id: "nsfw", label: "尺度", groups: ["level", "subLevel", "anatomy", "labiaType", "clitType", "vulvaState", "anatomyFocus", "pubic", "act", "fluids"] },
  { id: "world", label: "场景", groups: ["scene", "pose", "expression", "lighting", "film", "props"] },
];
const PARAMS_SEC_ID = "params";
const ORDER = SECTIONS.flatMap((s) => s.groups);
const RANK = { L1: 1, L2: 2, L3: 3, L4: 4, L5: 5, L6: 6 };

const state = {
  sel: {
    style: "photoReal", count: "solo", ethnicity: "jp", age: "22",
    faceShape: "oval", eyes: "almond", nose: "small", lips: "cherry", skin: "fair", makeup: "natural",
    height: "medium", frame: "standard", body: "g",
    breastShape: "peach", nippleType: "smallPink",
    outfit: "kimono", color: "none", fit: "none", underwear: "none", shoes: "none",
    level: "L2", subLevel: "S3",
    anatomy: "none", labiaType: "smallClosed", clitType: "hooded", vulvaState: "tight",
    pubic: "shaved", act: "none", fluids: "none",
    scene: "garden", pose: "lock", expression: "sweet", lighting: "rembrandt", film: "portra",
  },
  multi: { props: [], accessories: [], anatomyFocus: [], faceDetails: [], bodyDetails: [], breastDetails: [] },
  lang: "en",
  size: "portrait", count_imgs: 1, steps: 25, cfg: 1.0,
  seedMode: "random", fixedSeed: 100000, extra: "",
  mode: "random", lockImage: null, outfitImage: null,
};

/* ---------- WebSocket：实时采样进度 ----------
   注意：ComfyUI 的 /ws 有 Origin 校验，控制台页面（8189）直连 8188 会被 403 拒绝，
   因此暂不启用；如需实时采样进度，需要在 server.py 侧做 WS 代理，或给 ComfyUI 加
   --enable-cors-header。当前等待卡片用计时方式反馈。 */
let ws = null;
let wsReconnectTimer = null;
let wsClientId = "nsfw-" + Math.random().toString(36).substring(2, 15);
let wsProgress = { value: 0, max: 0, promptId: null };

function connectWS() {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//127.0.0.1:8188/ws?clientId=" + wsClientId);
    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === "progress") {
          wsProgress.value = msg.data.value;
          wsProgress.max = msg.data.max;
          var pending = document.querySelector("#gallery .card.pending");
          if (pending) updatePendingCard(pending);
        } else if (msg.type === "executing") {
          if (msg.data && msg.data.node === null) {
            wsProgress.value = 0; wsProgress.max = 0;
          }
        }
      } catch (e) { /* ignore binary */ }
    };
    ws.onclose = function() {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWS, 3000);
    };
    ws.onerror = function() { try { ws.close(); } catch(e) {} };
  } catch (e) { /* ignore */ }
}

function updatePendingCard(card) {
  if (!card) return;
  var started = parseInt(card.dataset.start || "0", 10);
  var sec = started ? Math.round((Date.now() - started) / 1000) : 0;
  var wait = sec >= 60 ? Math.floor(sec / 60) + "分" + (sec % 60) + "秒" : sec + "秒";
  var pct = wsProgress.max > 0 ? Math.round(wsProgress.value / wsProgress.max * 100) : 0;
  var info = wsProgress.max > 0
    ? "采样中 " + wsProgress.value + "/" + wsProgress.max + " 步（" + pct + "%）"
    : "排队/生成中…（已等待 " + wait + "）";
  card.innerHTML = '<div class="spinner"></div><div class="ptext">' + info + '</div>'
    + '<div class="mini-progress"><div class="mini-progress-bar" style="width:' + pct + '%"></div></div>';
  // 每秒刷新计时；卡片完成/被移除后自动停止
  if (!card._tick) {
    card._tick = setInterval(function () {
      if (!card.isConnected || !card.classList.contains("pending")) {
        clearInterval(card._tick); card._tick = null; return;
      }
      updatePendingCard(card);
    }, 1000);
  }
}

let running = false;
let stopRequested = false;
let results = [];
let upscaling = false;

/* ---------- 控制台画廊瀑布流：每张图按自身比例完整显示 ---------- */
// 注意：G_ROW / G_GAP 必须与 style.css 中 .gallery 的 grid-auto-rows / gap 保持一致
const G_ROW = 6, G_GAP = 13;
let galleryMasonryTimer = null;
function layoutGalleryMasonry() {
  document.querySelectorAll("#gallery .card, #hdGallery .card").forEach((card) => {
    if (!card.isConnected) return;
    const h = card.getBoundingClientRect().height;
    if (!h) return;
    card.style.gridRowEnd = "span " + Math.max(1, Math.ceil((h + G_GAP) / (G_ROW + G_GAP)));
  });
}
window.addEventListener("resize", () => {
  clearTimeout(galleryMasonryTimer);
  galleryMasonryTimer = setTimeout(layoutGalleryMasonry, 150);
});
// 手风琴：默认只展开“容貌”，其余板块折叠
const collapsedSecs = new Set(["facial", "body", "outfit", "nsfw", "world", PARAMS_SEC_ID]);

const $ = (s) => document.querySelector(s);
const findOpt = (g, id) => DATA[g].options.find((o) => o.id === id);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const frag = (g, id, lang) => {
  if (id === undefined || id === null) id = state.sel[g];
  const o = findOpt(g, id);
  return o ? ((lang === "zh" ? o.zh : o.en) || "") : "";
};
const E = (g, id) => frag(g, id, "en");
const Z = (g, id) => frag(g, id, "zh");
const isNude = () => ["L5", "L6"].includes(state.sel.level);
const isLowerNude = () => ["L4", "L5", "L6"].includes(state.sel.level);

/* ---------- 渲染 ---------- */
function chipHtml(key, o) {
  return `<button class="chip" data-group="${key}" data-id="${o.id}">
    <span class="cl">${o.label}</span>
    ${o.sub ? `<span class="cs">${o.sub}</span>` : ""}
  </button>`;
}
function groupHtml(key) {
  const g = DATA[key];
  return `<div class="group" data-group="${key}">
    <button type="button" class="gtitle" data-toggle="${key}">${g.label}<span class="arrow"></span></button>
    <div class="gbody"><div class="chips">${g.options.map((o) => chipHtml(key, o)).join("")}</div></div>
  </div>`;
}
function secHtml(sec) {
  const collapsed = collapsedSecs.has(sec.id) ? " collapsed" : "";
  return `<section class="sec${collapsed}" id="sec-${sec.id}">
    <button type="button" class="sec-title" data-sec-toggle="${sec.id}">
      <span>${sec.label}</span><span class="sec-arrow"></span>
    </button>
    <div class="sec-body">${sec.groups.map(groupHtml).join("")}</div>
  </section>`;
}

function renderOptions() {
  const nav = `<div class="navquick" id="navQuick">
    ${SECTIONS.map((s) => `<button type="button" data-sec="${s.id}">${s.label}</button>`).join("")}
    <button type="button" data-sec="${PARAMS_SEC_ID}">参数</button>
  </div>`;
  let html = nav;
  for (const sec of SECTIONS) html += secHtml(sec);
  const paramsCollapsed = collapsedSecs.has(PARAMS_SEC_ID) ? " collapsed" : "";
  html += `<section class="sec${paramsCollapsed}" id="sec-${PARAMS_SEC_ID}">
    <button type="button" class="sec-title" data-sec-toggle="${PARAMS_SEC_ID}">
      <span>生成参数</span><span class="sec-arrow"></span>
    </button>
    <div class="sec-body">${renderParams()}</div>
  </section>`;
  $("#optionsPanel").innerHTML = html;
  bindClicks();
  bindParams();
  bindNavAndCollapse();
  refreshActive();
  refreshNav();
}

function renderParams() {
  const langBtns = LANGS.map((l) => `<button data-lang="${l.id}">${l.label}</button>`).join("");
  const sizeBtns = SIZES.map((s) => `<button data-size="${s.id}">${s.label}</button>`).join("");
  return `<div class="params">
    <div class="param-row"><label>提示词语言</label><div class="seg" id="langSeg">${langBtns}</div></div>
    <div class="param-row"><label>尺寸</label><div class="seg" id="sizeSeg">${sizeBtns}</div></div>
    <div class="param-row"><label>张数</label>
      <input type="number" id="countInput" min="1" max="8" value="${state.count_imgs}">
      <span style="color:var(--muted);font-size:11px">串行逐张（1–8）</span></div>
    <div class="param-row"><label>步数</label>
      <input type="range" id="stepsRange" min="15" max="35" value="${state.steps}">
      <span class="range-val" id="stepsVal">${state.steps}</span></div>
    <div class="param-row"><label>CFG</label><div class="seg" id="cfgSeg">
      <button data-cfg="1">1.0（推荐）</button><button data-cfg="1.5">1.5</button><button data-cfg="2">2.0</button>
    </div></div>
    <div class="param-row"><label>种子</label><div class="seg" id="seedSeg">
      <button data-seed="random">随机</button><button data-seed="fixed">固定</button>
    </div><input type="number" id="fixedSeedInput" value="${state.fixedSeed}" style="display:none"></div>
    <div class="param-row" style="flex-direction:column;align-items:stretch">
      <label style="width:auto;margin-bottom:6px">自定义追加（可选）</label>
      <textarea class="extra" id="extraInput"></textarea></div>
  </div>`;
}

/* ---------- 联动：尺度 / 动作 / 体液，保证不矛盾 ---------- */
function applyLevelDefaults(level) {
  const map = {
    L1: { anatomy: "none", pose: "lock" },
    L2: { anatomy: "none", pose: "lock" },
    L3: { anatomy: "none", pose: "sitChair" },
    L4: { anatomy: "compact", pose: "standHip", labiaType: "smallClosed", clitType: "hooded", vulvaState: "tight" },
    L5: { anatomy: "full", subLevel: "S3", pose: "kneeBent", labiaType: "peek", clitType: "peek", vulvaState: "dewy" },
    L6: { anatomy: "spread", subLevel: "S4", pose: "spreadSit", labiaType: "innerFull", clitType: "prominent", vulvaState: "spread" },
  };
  if (map[level]) Object.assign(state.sel, map[level]);
}

const ACT_SOLO = ["mastFinger", "mastToy", "mastDouble", "analToy", "heldOpen", "mirror", "fisting", "bondage", "suspended", "petPlay"];
const ACT_LES = ["lesbian", "lesbianToy"];
function applyAct(act) {
  if (act === "none" || act === "tease") return;
  let count = "boygirl";
  let level = "L5";
  if (ACT_SOLO.includes(act)) count = "solo";
  else if (ACT_LES.includes(act)) count = "girls2";
  else if (act === "group") { count = "group"; level = "L6"; }
  if (act === "mastDouble" || act === "fisting" || act === "dp") level = "L6";
  state.sel.count = count;
  state.sel.level = level;
  applyLevelDefaults(level);
}

function applyFluid(fl) {
  const high = ["slick", "squirt", "creampie", "cumBody", "cumFace"];
  if (high.includes(fl) && RANK[state.sel.level] < 5) {
    state.sel.level = "L5"; applyLevelDefaults("L5");
  } else if (fl === "lactation" && RANK[state.sel.level] < 3) {
    state.sel.level = "L3"; applyLevelDefaults("L3");
  }
}

function bindClicks() {
  $("#optionsPanel").addEventListener("click", (e) => {
    if (e.target.closest("[data-toggle], [data-sec-toggle]")) return; // 折叠单独处理
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const g = chip.dataset.group;
    const id = chip.dataset.id;
    const s = state.sel;

    if (g === "facePreset") {
      const p = FACE_PRESETS.find((x) => x.id === id);
      if (p) {
        Object.assign(s, p.set);
        state.multi.faceDetails = [...p.details];
        refreshActive(); compile();
      }
      return;
    }
    if (DATA[g].multi) {
      const arr = state.multi[g];
      const i = arr.indexOf(id);
      if (i >= 0) arr.splice(i, 1); else arr.push(id);
    } else {
      if ((g === "outfit" || g === "underwear") && isNude()) return;
      if (g === "subLevel" && !isNude()) return;
      if (["labiaType", "clitType", "vulvaState", "anatomy"].includes(g) && !isLowerNude()) return;
      if (g === "pose" && s.act !== "none") return;   // 动作接管姿势
      if (g === "count" && s.act !== "none") return;  // 动作接管人数
      s[g] = id;
      if (g === "level") applyLevelDefaults(id);
      if (g === "act") applyAct(id);
      if (g === "fluids") applyFluid(id);
    }
    refreshActive();
    compile();
  });
}

/* ---------- 手风琴 / 折叠 ---------- */
function setSecCollapsed(id, collapsed) {
  const el = document.getElementById("sec-" + id);
  if (!el) return;
  el.classList.toggle("collapsed", collapsed);
  if (collapsed) collapsedSecs.add(id); else collapsedSecs.delete(id);
}
function openSec(id) {
  const all = [...SECTIONS.map((s) => s.id), PARAMS_SEC_ID];
  for (const x of all) setSecCollapsed(x, x !== id);
  refreshNav();
  const el = document.getElementById("sec-" + id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}
function refreshNav() {
  document.querySelectorAll("#navQuick [data-sec]").forEach((b) => {
    b.classList.toggle("active", !collapsedSecs.has(b.dataset.sec));
  });
}
function bindNavAndCollapse() {
  $("#navQuick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sec]");
    if (!b) return;
    openSec(b.dataset.sec);
  });
  $("#optionsPanel").addEventListener("click", (e) => {
    const secT = e.target.closest("[data-sec-toggle]");
    if (secT) { setSecCollapsed(secT.dataset.secToggle, !collapsedSecs.has(secT.dataset.secToggle)); refreshNav(); return; }
    const t = e.target.closest("[data-toggle]");
    if (t) t.closest(".group").classList.toggle("collapsed");
  });
}

function bindParams() {
  $("#langSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.lang = b.dataset.lang; refreshActive(); compile();
  });
  $("#sizeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.size = b.dataset.size; refreshActive();
  });
  $("#cfgSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.cfg = parseFloat(b.dataset.cfg); refreshActive();
  });
  $("#seedSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.seedMode = b.dataset.seed;
    $("#fixedSeedInput").style.display = state.seedMode === "fixed" ? "inline-block" : "none";
    refreshActive();
  });
  $("#fixedSeedInput").addEventListener("input", (e) => (state.fixedSeed = parseInt(e.target.value || "0", 10)));
  $("#countInput").addEventListener("input", (e) => {
    state.count_imgs = Math.max(1, Math.min(8, parseInt(e.target.value || "1", 10)));
  });
  $("#stepsRange").addEventListener("input", (e) => {
    state.steps = parseInt(e.target.value, 10); $("#stepsVal").textContent = state.steps;
  });
  $("#extraInput").addEventListener("input", (e) => { state.extra = e.target.value; compile(); });
}

function refreshActive() {
  const nude = isNude();
  const lowerNude = isLowerNude();
  const actOn = state.sel.act !== "none";
  document.querySelectorAll(".chip").forEach((c) => {
    const g = c.dataset.group;
    let on;
    if (DATA[g].multi) on = state.multi[g].includes(c.dataset.id);
    else on = state.sel[g] === c.dataset.id;
    c.classList.toggle("active", on);

    let dis = false;
    if (g === "outfit" || g === "underwear") dis = nude;
    if (g === "subLevel") dis = !nude;
    if (g === "labiaType" || g === "clitType" || g === "vulvaState" || g === "anatomy") dis = !lowerNude;
    if (g === "pose" || g === "count") dis = actOn;
    c.classList.toggle("disabled", dis);
  });
  document.querySelectorAll("#langSeg button").forEach((b) => b.classList.toggle("active", state.lang === b.dataset.lang));
  document.querySelectorAll("#sizeSeg button").forEach((b) => b.classList.toggle("active", state.size === b.dataset.size));
  document.querySelectorAll("#cfgSeg button").forEach((b) => b.classList.toggle("active", Math.abs(state.cfg - parseFloat(b.dataset.cfg)) < 0.01));
  document.querySelectorAll("#seedSeg button").forEach((b) => b.classList.toggle("active", state.seedMode === b.dataset.seed));
}

/* ---------- 着装块（按尺度自洽） ---------- */
function colorFitEn() {
  const color = E("color"), fit = E("fit");
  let cf = "";
  if (color) cf += " The outfit is " + color;
  if (fit) cf += (color ? ", with a " : " It has a ") + fit + " cut";
  return cf ? cf + "." : "";
}
function outfitBlockEn() {
  const s = state.sel, lv = s.level;
  const outfit = E("outfit");
  let t = "";
  if (lv === "L1") t = " She is dressed in " + outfit + ", closed and tidy, fully covering her chest and hips." + colorFitEn();
  else if (lv === "L2") t = " She wears " + outfit + ", which has slipped off one shoulder to show a line of cleavage while still covering her chest and hips." + colorFitEn();
  else if (lv === "L3") t = " Her outfit is pulled down to her elbows, leaving her breasts bare, the lower part still covering her to mid-thigh.";
  else if (lv === "L4") t = " Her outfit has fallen open and slid down, her breasts bare, with only the sash and a jeweled hip chain around her otherwise bare lower body.";
  else {
    t = " She is completely nude, no clothing on her body, her garments folded on the ground behind her, only a jeweled hip chain that covers nothing.";
    if (lv === "L5") t += " " + E("subLevel");
    else t += " She spreads her legs wide open toward the camera, presenting her fully exposed genitals with nothing covering them.";
  }
  if (lv === "L1" || lv === "L2") {
    const uw = E("underwear"); if (uw) t += " Underneath she wears " + uw + ".";
    const sh = E("shoes"); if (sh) t += " On her feet, " + sh + ".";
  }
  if (state.multi.accessories.length) t += " She wears " + state.multi.accessories.map((i) => E("accessories", i)).join(", ") + ".";
  return t;
}
function colorFitZh() {
  const color = Z("color"), fit = Z("fit");
  let cf = "";
  if (color) cf += "衣服为" + color;
  if (fit) cf += (color ? "，" : "") + fit + "版型";
  return cf ? cf + "。" : "";
}
function outfitBlockZh() {
  const s = state.sel, lv = s.level;
  const outfit = Z("outfit");
  let t = "";
  if (lv === "L1") t = "她整齐地穿着" + outfit + "，完全遮住胸部和臀部。" + colorFitZh();
  else if (lv === "L2") t = "她穿着" + outfit + "，衣服从一侧肩膀滑落、露出一点乳沟，胸部和臀部仍遮住。" + colorFitZh();
  else if (lv === "L3") t = "她把上衣褪到手肘，露出赤裸的胸部，下身仍遮到大腿中部。";
  else if (lv === "L4") t = "她的衣服敞开滑落，胸部赤裸，近乎赤裸的下身只有腰带和珠宝胯链。";
  else {
    t = "她完全赤裸，身上没有衣服，衣服叠放在身后地上，只有一条什么都遮不住的珠宝胯链。";
    if (lv === "L5") t += Z("subLevel");
    else t += "她朝镜头大大张开双腿，展示完全裸露的生殖器，没有任何遮挡。";
  }
  if (lv === "L1" || lv === "L2") {
    const uw = Z("underwear"); if (uw) t += "内着" + uw + "。";
    const sh = Z("shoes"); if (sh) t += "脚上" + sh + "。";
  }
  if (state.multi.accessories.length) t += "佩戴" + state.multi.accessories.map((i) => Z("accessories", i)).join("、") + "。";
  return t;
}

/* ---------- 阴部块（结构 + 形态，互不重复） ---------- */
function genitalBlockEn() {
  let t = "";
  const an = E("anatomy"); if (an) t += " " + an;
  t += " Her lips are " + E("labiaType") + ", with " + E("clitType") + "; her vulva is " + E("vulvaState") + ".";
  t += " " + cap(E("pubic")) + ".";
  return t;
}
function genitalBlockZh() {
  let t = "";
  const an = Z("anatomy"); if (an) t += an;
  t += "阴唇" + Z("labiaType") + "，" + Z("clitType") + "；阴部" + Z("vulvaState") + "。";
  t += Z("pubic") + "。";
  return t;
}

/* ---------- 英文编译 ---------- */
function compileEn() {
  const s = state.sel;
  const style = findOpt("style", s.style);
  let p = style.en + " ";

  if (s.count === "solo") p += cap(E("ethnicity")) + ".";
  else p += cap(E("count")) + ". The central woman is " + E("ethnicity") + ".";
  const age = E("age");
  if (age) p += cap(age.replace(/,$/, "")) + ".";

  p += " She has " + E("faceShape") + ", " + E("eyes") + ", " + E("nose") +
    ", " + E("lips") + ", and " + E("skin") + ".";
  if (s.makeup === "none") p += " She wears no makeup, a bare natural face.";
  else p += " Her makeup is " + E("makeup") + ".";
  if (state.multi.faceDetails.length)
    p += " Facial details: " + state.multi.faceDetails.map((i) => E("faceDetails", i)).join(", ") + ".";

  p += " She is of " + E("height") + ", with " + E("frame") + ".";
  p += " She has " + E("body") + ".";
  if (state.multi.bodyDetails.length)
    p += " Body details: " + state.multi.bodyDetails.map((i) => E("bodyDetails", i)).join(", ") + ".";
  p += " Her breasts are " + E("breastShape") + ", with " + E("nippleType") + ".";
  if (state.multi.breastDetails.length)
    p += " Breast details: " + state.multi.breastDetails.map((i) => E("breastDetails", i)).join(", ") + ".";

  p += outfitBlockEn();
  if (isLowerNude()) p += genitalBlockEn();
  if (state.multi.anatomyFocus.length)
    p += " Close-up emphasis: " + state.multi.anatomyFocus.map((i) => E("anatomyFocus", i)).join(", ") + ".";

  p += " The scene is " + E("scene") + ".";
  const act = E("act");
  if (act) p += " " + act; else p += " " + E("pose");
  const fl = E("fluids");
  if (fl) p += " " + cap(fl) + ".";
  p += " She carries " + E("expression") + ".";
  p += " She is lit by " + E("lighting") + ".";
  p += " The image is " + E("film") + ".";
  if (state.multi.props.length)
    p += " Accessories include " + state.multi.props.map((i) => E("props", i)).join(", ") + ".";
  if (state.extra.trim()) p += " " + state.extra.trim();

  p += " Exactly two hands with five fingers each, exactly two arms and two legs, natural anatomically correct limbs.";
  p += style.kind === "real"
    ? " Photorealistic skin texture with delicate pores, shallow depth of field, high detail."
    : " Detailed lighting, crisp linework, rich color, highly detailed.";
  return p;
}

/* ---------- 中文编译 ---------- */
function compileZh() {
  const s = state.sel;
  const style = findOpt("style", s.style);
  let p = style.zh;

  if (s.count === "solo") p += Z("ethnicity") + "。";
  else { p += Z("count") + "。居中的女性" + Z("ethnicity") + "。"; }
  const age = Z("age");
  if (age) p += age.replace(/，$/, "") + "。";

  p += "她有着" + Z("faceShape") + "、" + Z("eyes") + "、" + Z("nose") +
    "、" + Z("lips") + "，以及" + Z("skin") + "。";
  if (s.makeup === "none") p += "她素颜，没有化妆。";
  else p += "妆容是" + Z("makeup") + "。";
  if (state.multi.faceDetails.length)
    p += "面部细节：" + state.multi.faceDetails.map((i) => Z("faceDetails", i)).join("、") + "。";

  p += "她" + Z("height") + "，体型" + Z("frame") + "。";
  p += "她有着" + Z("body") + "。";
  if (state.multi.bodyDetails.length)
    p += "身体细节：" + state.multi.bodyDetails.map((i) => Z("bodyDetails", i)).join("、") + "。";
  p += "她的乳房" + Z("breastShape") + "，" + Z("nippleType") + "。";
  if (state.multi.breastDetails.length)
    p += "乳房细节：" + state.multi.breastDetails.map((i) => Z("breastDetails", i)).join("、") + "。";

  p += outfitBlockZh();
  if (isLowerNude()) p += genitalBlockZh();
  if (state.multi.anatomyFocus.length)
    p += "特写强调：" + state.multi.anatomyFocus.map((i) => Z("anatomyFocus", i)).join("、") + "。";

  p += "场景是" + Z("scene") + "。";
  const act = Z("act");
  if (act) p += act; else p += Z("pose");
  const fl = Z("fluids");
  if (fl) p += fl + "。";
  p += "她" + Z("expression") + "。";
  p += "灯光为" + Z("lighting") + "。";
  p += "画面为" + Z("film") + "。";
  if (state.multi.props.length)
    p += "道具包括" + state.multi.props.map((i) => Z("props", i)).join("、") + "。";
  if (state.extra.trim()) p += state.extra.trim();

  p += "恰好两只手、每只五根手指，恰好两条手臂和两条腿，解剖结构正确。";
  p += style.kind === "real"
    ? "皮肤写实质感、毛孔细腻，浅景深，高细节。"
    : "光影细致，线条清晰，色彩丰富，高细节。";
  return p;
}

function compileNegative() {
  const s = state.sel;
  let n = NEG_BASE;
  if (isLowerNude() || s.act !== "none") n += ", " + NEG_NSFW;
  return n;
}

function compileLockedZh() {
  const s = state.sel;
  let p = "超写实真人摄影。";
  p += "保持<image1>中人物的面部特征、五官、神情、发型、身材体型、胸部、肤色完全不变，必须是同一个人，身份一致。";
  p += outfitBlockZh();
  if (isLowerNude()) p += genitalBlockZh();
  if (state.multi.anatomyFocus.length)
    p += "特写强调：" + state.multi.anatomyFocus.map((i) => Z("anatomyFocus", i)).join("、") + "。";
  p += "场景是" + Z("scene") + "。";
  const act = Z("act");
  p += act ? act : Z("pose");
  const fl = Z("fluids");
  if (fl) p += fl + "。";
  p += "她" + Z("expression") + "。";
  p += "灯光为" + Z("lighting") + "。";
  p += "画面为" + Z("film") + "。";
  if (state.multi.props.length)
    p += "道具包括" + state.multi.props.map((i) => Z("props", i)).join("、") + "。";
  p += "恰好两只手、每只五根手指，恰好两条手臂和两条腿，解剖结构正确。";
  p += "皮肤写实质感、毛孔细腻，浅景深，高细节。";
  return p;
}

function compile(writeTo) {
  let pos;
  if (state.mode === "lock") pos = compileLockedZh();
  else if (state.lang === "en") pos = compileEn();
  else if (state.lang === "zh") pos = compileZh();
  else pos = compileEn() + "\n" + compileZh();
  const neg = compileNegative();
  // 关键词拼接面板现位于「生成中心」（方式②），默认把编译结果写入生成中心的提示词框；
  // 控制台本地流程（锁脸/参考图/服饰/人脸）传 "console"；初始化传 "both"。
  const to = writeTo || "gc";
  if (to === "gc" || to === "both") {
    const gp = $("#gcPositive"), gn = $("#gcNegative");
    if (gp) gp.value = pos;
    if (gn) gn.value = neg;
  }
  if (to === "console" || to === "both") {
    $("#positive").value = pos;
    $("#negative").value = neg;
  }
}
// 暴露给生成中心：进入「关键词拼接」时用当前选项刷新一次编译结果
window.gcCompile = compile;

/* ---------- ComfyUI 状态 ---------- */
async function checkSystem() {
  try {
    const [sysR, queueR] = await Promise.all([
      fetch("/api/system"),
      fetch("/api/queue").catch(() => ({ json: async () => ({ queue_running: [], queue_pending: [] }) }))
    ]);
    const d = await sysR.json();
    const q = await queueR.json();
    const el = $("#comfyStatus");
    if (d.online) {
      el.classList.remove("down"); el.classList.add("up");
      const running = (q.queue_running || []).length;
      const pending = (q.queue_pending || []).length;
      const dev = d.devices && d.devices[0];
      const vramPct = dev ? Math.round((1 - dev.vram_free / dev.vram_total) * 100) : 0;
      if (running > 0) {
        el.classList.add("generating");
        $("#statusText").textContent =
          `生成中（运行${running}${pending ? " 排队" + pending : ""}）· GPU ${vramPct}% · 内存空闲 ${(d.system.ram_free / 1073741824).toFixed(1)}G`;
      } else {
        el.classList.remove("generating");
        $("#statusText").textContent =
          `ComfyUI 在线 · 空闲 · GPU ${vramPct}% · 内存空闲 ${(d.system.ram_free / 1073741824).toFixed(1)}G`;
      }
    } else {
      el.classList.remove("up", "generating"); el.classList.add("down");
      $("#statusText").textContent = "ComfyUI 离线（请先启动）";
    }
  } catch (e) { /* ignore */ }
}

/* ---------- 生成 ---------- */
function viewUrl(im) {
  return `/api/view?filename=${enc(im.filename)}&subfolder=${enc(im.subfolder || "")}&type=${enc(im.type || "output")}`;
}
const randomSeed = () => Math.floor(Math.random() * 2147483647);

function addPending(index, promptText, seed) {
  const card = document.createElement("div");
  card.className = "card pending";
  card.dataset.seed = seed;
  card.dataset.prompt = (promptText || "").substring(0, 80);
  card.dataset.start = Date.now();
  updatePendingCard(card);
  $("#gallery").appendChild(card);
  layoutGalleryMasonry();
  return card;
}
function finishCard(card, im, index) {
  if (card._tick) { clearInterval(card._tick); card._tick = null; }
  const url = viewUrl(im);
  card.className = "card";
  card.dataset.idx = index;
  const seed = card.dataset.seed || "?";
  const prompt = card.dataset.prompt || "";
  const titleAttr = prompt.replace(/"/g, "&quot;");
  card.innerHTML = `<div class="pickmark">✓</div>
    <img src="${url}" alt="r${index + 1}">
    <div class="meta">
      <span>第 ${index + 1} 张 · seed:${seed}</span>
      <a href="${url}" download="${im.filename}">下载</a>
    </div>
    <div class="prompt-snippet" title="${titleAttr}">${prompt}${prompt.length >= 80 ? "…" : ""}</div>`;
  // 图片加载后高度会变化，需要重算瀑布流行跨度
  const fimg = card.querySelector("img");
  if (fimg) {
    fimg.addEventListener("load", layoutGalleryMasonry);
    if (fimg.complete) layoutGalleryMasonry();
  }
  layoutGalleryMasonry();
}

function bindPicking() {
  $("#gallery").addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const card = e.target.closest(".card");
    if (!card || card.classList.contains("pending")) return;
    card.classList.toggle("picked");
    updateUpscaleState();
  });
}
function pickedCards() {
  return [...document.querySelectorAll("#gallery .card.picked")];
}
function updateUpscaleState() {
  const n = pickedCards().length;
  $("#upscaleBtn").disabled = n === 0 || running || upscaling;
  $("#upscaleBtn").textContent = n ? `放大选中 ${n} 张（4x）` : "放大选中（4x）";
  const total = results.filter(Boolean).length;
  $("#selectAllBtn").textContent = (n && n === total) ? "取消全选" : "全选";
}
function errorCard(card, index, msg) {
  if (card._tick) { clearInterval(card._tick); card._tick = null; }
  card.className = "card pending";
  card.innerHTML = `<div class="ptext" style="color:var(--warn)">第 ${index + 1} 张失败</div>
    <div class="ptext" style="font-size:11px;max-width:210px;text-align:center">${msg || ""}</div>`;
  layoutGalleryMasonry();
}

async function pollHistory(pid) {
  wsProgress.promptId = pid;
  const deadline = Date.now() + 1500000;
  while (Date.now() < deadline) {
    const r = await fetch("/api/history?id=" + enc(pid));
    const d = await r.json();
    if (d.done) {
      if (d.status_str === "error") {
        const msg = (d.messages || []).filter((m) => m[0] === "execution_error")
          .map((m) => m[1] && m[1].exception_message).find(Boolean);
        throw new Error(msg || "ComfyUI 执行出错");
      }
      if (d.images && d.images.length) return d.images[0];
      throw new Error("已完成但没有输出图片");
    }
    await sleep(3000);
  }
  throw new Error("超时（>25 分钟）");
}

function fmtDur(sec) {
  if (!sec || sec < 0) return "--";
  if (sec < 60) return Math.round(sec) + "秒";
  if (sec < 3600) return Math.round(sec / 60) + "分钟";
  return (sec / 3600).toFixed(1) + "小时";
}

async function generate() {
  if (running) return;
  if (state.mode === "lock" && !state.lockImage) {
    $("#progress").textContent = "请先上传参考人物图";
    return;
  }
  const size = SIZES.find((s) => s.id === state.size);
  const n = state.count_imgs;
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  running = true; stopRequested = false;
  results = [];
  $("#generateBtn").disabled = true; $("#stopBtn").disabled = false;
  $("#upscaleBtn").disabled = true;
  $("#gallery").innerHTML = "";
  $("#genProgress").classList.add("active");

  const genStart = Date.now();
  for (let i = 0; i < n; i++) {
    if (stopRequested) break;
    const pct = Math.round(i / n * 100);
    $("#genProgressBar").style.width = pct + "%";
    const elapsed = (Date.now() - genStart) / 1000;
    const perImg = i > 0 ? elapsed / i : 160;
    const eta = (n - i - 1) * perImg;
    $("#progress").innerHTML = `生成 <b>${i + 1}/${n}</b>（${pct}%）· 已用 ${fmtDur(elapsed)} · 剩余约 ${fmtDur(eta)}`;
    const seed = state.seedMode === "random" ? randomSeed() : state.fixedSeed + i;
    const card = addPending(i, $("#positive").value, seed);
    const payload = {
      positive: $("#positive").value, negative: $("#negative").value,
      width: size.w, height: size.h, batch: 1,
      seed, steps: state.steps, cfg: state.cfg,
      prefix: `nsfw-studio/${dateStr}`,
    };
    if (state.mode === "lock") payload.lock_image = state.lockImage;
    if (state.outfitImage) payload.outfit_image = state.outfitImage;
    if (state.img2imgEnabled && state.img2imgImage) {
      payload.img2img_image = state.img2imgImage;
      payload.denoise = state.denoise;
    }
    try {
      const r = await fetch("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      const im = await pollHistory(d.prompt_id);
      results[i] = im;
      finishCard(card, im, i);
    } catch (e) {
      errorCard(card, i, e.message);
      if (stopRequested) break;
    }
  }
  running = false;
  $("#genProgressBar").style.width = "100%";
  $("#generateBtn").disabled = false; $("#stopBtn").disabled = true;
  updateUpscaleState();
  // 记录到生成历史
  const okImages = results.filter(Boolean);
  if (okImages.length) {
    try {
      fetch("/api/genhistory/add", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positive: $("#positive").value,
          negative: $("#negative").value,
          seed: state.seedMode === "fixed" ? state.fixedSeed : null,
          width: size.w, height: size.h,
          steps: state.steps, cfg: state.cfg,
          images: okImages,
          lock_image: state.mode === "lock" ? state.lockImage : null,
          outfit_image: state.outfitImage || null,
        }),
      }).then(() => loadGenHistory());
    } catch (e) { /* ignore */ }
  }
  const totalTime = (Date.now() - genStart) / 1000;
  $("#progress").textContent = stopRequested
    ? `已中断（${results.filter(Boolean).length} 张完成，用时 ${fmtDur(totalTime)}）`
    : `完成 ${results.filter(Boolean).length} 张，用时 ${fmtDur(totalTime)}，点击图片勾选后点「放大选中」`;
}

async function stop() {
  // 注意：ComfyUI 的 /interrupt 是全局的，会中断当前正在运行的任意任务——
  // 如果此时外部批量脚本（千问批量）也在跑，它当前这一张会被一并中断。
  if (!confirm("中断会立即停止 ComfyUI 上正在运行的任务。\n如果你同时在跑外部批量脚本，它当前正在生成的这一张也会被中断。\n\n确定要中断吗？")) return;
  stopRequested = true;
  $("#progress").textContent = "正在中断…";
  await fetch("/api/interrupt", { method: "POST" });
}

/* ---------- 4x 高清成品 ---------- */
function addHdCard(im) {
  if ($("#hdGallery .empty-hint")) $("#hdGallery").innerHTML = "";
  const url = viewUrl(im);
  const card = document.createElement("div");
  card.className = "card hdcard";
  card.innerHTML = `<div class="hdtag">4x</div><img src="${url}" alt="hd">
    <div class="meta"><span>高清成品</span><a href="${url}" download="${im.filename}">下载</a></div>`;
  $("#hdGallery").appendChild(card);
  // 高清图加载后高度才确定，需要按实际高度重算瀑布流行跨度（与主画廊同一机制）
  const img = card.querySelector("img");
  if (img) {
    img.addEventListener("load", layoutGalleryMasonry);
    if (img.complete) layoutGalleryMasonry();
  }
  layoutGalleryMasonry();
}

async function upscaleSelected() {
  const cards = pickedCards();
  if (!cards.length || upscaling) return;
  upscaling = true;
  $("#upscaleBtn").disabled = true; $("#generateBtn").disabled = true;
  let k = 0;
  for (const card of cards) {
    const im = results[card.dataset.idx];
    $("#progress").innerHTML = `正在高清放大 <b>第 ${++k}/${cards.length} 张</b>…`;
    try {
      const r = await fetch("/api/upscale", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(im),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      addHdCard(await pollHistory(d.prompt_id));
    } catch (e) {
      $("#progress").textContent = "放大失败：" + e.message;
      break;
    }
  }
  upscaling = false;
  $("#generateBtn").disabled = false;
  updateUpscaleState();
  if (k === cards.length)
    $("#progress").textContent = `高清放大完成，共 ${cards.length} 张（已保存）`;
}

function toggleSelectAll() {
  const cards = [...document.querySelectorAll("#gallery .card")]
    .filter((c) => !c.classList.contains("pending"));
  const allOn = cards.length && cards.every((c) => c.classList.contains("picked"));
  cards.forEach((c) => c.classList.toggle("picked", !allOn));
  updateUpscaleState();
}

/* ---------- 模式 / 参考图 ---------- */
function bindModeAndRef() {
  $("#modeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.mode = b.dataset.mode;
    $("#modeSeg").querySelectorAll("button").forEach((x) =>
      x.classList.toggle("active", x === b));
    $("#lockBox").style.display = state.mode === "lock" ? "flex" : "none";
    compile("console");
  });
  $("#refFile").addEventListener("change", (e) => {
    const f = e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      $("#refPreview").src = dataUrl;
      $("#progress").textContent = "正在上传参考图…";
      try {
        const r = await fetch("/api/upload", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: dataUrl }),
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error);
        state.lockImage = d.image;
        $("#progress").textContent = "参考图已就绪，可以生成同一人写真";
        compile("console");
      } catch (err) {
        $("#progress").textContent = "上传失败：" + err.message;
      }
    };
    reader.readAsDataURL(f);
  });
  $("#clearRef").addEventListener("click", () => {
    state.lockImage = null;
    state.outfitImage = null;
    $("#refFile").value = "";
    $("#refPreview").removeAttribute("src");
    const op2 = document.getElementById("outfitPreview");
    if (op2) { op2.removeAttribute("src"); op2.style.display = "none"; }
    compile("console");
  });

  // 服饰库选用后调用：设置服饰参考图
  window.setOutfitRef = function(outfitPath, outfitName) {
    state.outfitImage = outfitPath;
    const parts = outfitPath.split("/");
    const fn = parts[parts.length - 1];
    const sub = parts.slice(0, -1).join("/");
    // 在 lockBox 里显示服饰预览（如果有 outfitPreview 元素）
    const op = document.getElementById("outfitPreview");
    if (op) {
      op.src = `/api/view?filename=${encodeURIComponent(fn)}&subfolder=${encodeURIComponent(sub)}&type=input`;
      op.style.display = "block";
    }
    $("#progress").textContent = `已选用服饰「${outfitName}」`;
    compile("console");
  };

  // 人脸库选脸后调用：直接设置已存在的 input 图片作为锁脸参考
  window.setLockFace = function(facePath, faceName) {
    // 切到 lock 模式
    state.mode = "lock";
    $("#modeSeg").querySelectorAll("button").forEach((x) =>
      x.classList.toggle("active", x.dataset.mode === "lock"));
    $("#lockBox").style.display = "flex";
    state.lockImage = facePath;
    // 预览图：characters/xxx.png -> /api/view?filename=xxx.png&subfolder=characters&type=input
    const parts = facePath.split("/");
    const fn = parts[parts.length - 1];
    const sub = parts.slice(0, -1).join("/");
    $("#refPreview").src = `/api/view?filename=${encodeURIComponent(fn)}&subfolder=${encodeURIComponent(sub)}&type=input`;
    $("#progress").textContent = `已选用人脸「${faceName}」，可以生成同一人写真`;
    compile("console");
  };

  // 从图库"生成变体"：带入该图的提示词和种子，切到控制台
  window.useImageVariant = function(prompt, seed, filename) {
    if (prompt) $("#positive").value = prompt;
    if (seed && !isNaN(seed)) {
      state.seedMode = "fixed";
      state.fixedSeed = parseInt(seed, 10);
      $("#fixedSeedInput").value = state.fixedSeed;
      $("#fixedSeedInput").style.display = "inline-block";
      document.querySelectorAll("#seedSeg button").forEach((b) =>
        b.classList.toggle("active", b.dataset.seed === "fixed"));
    }
    if (window.showPage) window.showPage("console");
    // 注意：此处不能调用 compile()，否则会立即用实时编译结果覆盖刚带入的提示词
    $("#progress").textContent = `已从图库带入变体提示词与种子${filename ? "（" + filename + "）" : ""}，可直接生成；改动左侧选项会重新编译`;
  };
  $("#upscaleBtn").addEventListener("click", upscaleSelected);
  $("#selectAllBtn").addEventListener("click", toggleSelectAll);
}

/* ---------- init ---------- */
renderOptions();
compile("both");
checkSystem();
setInterval(checkSystem, 15000);
$("#generateBtn").addEventListener("click", generate);
$("#stopBtn").addEventListener("click", stop);
bindPicking();
bindModeAndRef();
document.querySelector('#modeSeg [data-mode="random"]').classList.add("active");

/* ---------- 生成历史 ---------- */
async function loadGenHistory() {
  try {
    const r = await fetch("/api/genhistory/list?size=30");
    const d = await r.json();
    const cnt = document.getElementById("genHistoryCount");
    if (cnt) cnt.textContent = "（" + d.total + " 条）";
    renderGenHistory(d.items);
  } catch (e) { /* ignore */ }
}

function renderGenHistory(items) {
  const el = document.getElementById("genHistoryList");
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="empty-hint">暂无历史记录</div>'; return; }
  el.innerHTML = items.map(function(rec) {
    var firstImg = rec.images && rec.images[0];
    var thumb = firstImg ? "/api/thumb?filename=" + encodeURIComponent(firstImg.filename) + "&subfolder=" + encodeURIComponent(firstImg.subfolder || "") + "&type=output" : "";
    var time = rec.created_at ? new Date(rec.created_at * 1000) : null;
    var timeStr = time ? (time.getMonth()+1) + "/" + time.getDate() + " " + String(time.getHours()).padStart(2,"0") + ":" + String(time.getMinutes()).padStart(2,"0") : "";
    return '<div class="gen-history-card" data-id="' + rec.id + '">' +
      (thumb ? '<img class="gen-history-thumb" src="' + thumb + '" alt="history" loading="lazy">' : '<div class="gen-history-thumb" style="background:#333"></div>') +
      '<div class="gen-history-info">' +
        '<div class="gen-history-prompt" title="' + (rec.positive||"").replace(/"/g,"&quot;") + '">' + (rec.positive||"").substring(0,80) + ((rec.positive||"").length>80?"…":"") + '</div>' +
        '<div class="gen-history-meta"><span>' + rec.width + 'x' + rec.height + '</span><span>' + timeStr + '</span></div>' +
      '</div>' +
      '<div class="gen-history-actions">' +
        '<button class="ghost tiny" data-act="regen">重生成</button>' +
        '<button class="ghost tiny" data-act="copy">复制</button>' +
        '<button class="ghost tiny" data-act="view">查看</button>' +
      '</div>' +
    '</div>';
  }).join("");
  el.querySelectorAll(".gen-history-card").forEach(function(card) {
    var id = parseInt(card.dataset.id);
    var rec = items.find(function(x) { return x.id === id; });
    if (!rec) return;
    card.querySelector('[data-act="regen"]').addEventListener("click", function() {
      if (rec.positive) document.getElementById("positive").value = rec.positive;
      if (rec.negative) document.getElementById("negative").value = rec.negative;
      if (rec.seed && !isNaN(rec.seed)) {
        state.seedMode = "fixed"; state.fixedSeed = parseInt(rec.seed, 10);
        document.getElementById("fixedSeedInput").value = state.fixedSeed;
        document.getElementById("fixedSeedInput").style.display = "inline-block";
        document.querySelectorAll("#seedSeg button").forEach(function(b) {
          b.classList.toggle("active", b.dataset.seed === "fixed");
        });
      }
      if (window.showPage) window.showPage("console");
      document.getElementById("progress").textContent = "已填入历史参数，点击生成";
      // 不能调用 compile()：否则会覆盖刚填入的提示词
    });
    card.querySelector('[data-act="copy"]').addEventListener("click", function(e) {
      navigator.clipboard.writeText(rec.positive || "").then(function() {
        e.target.textContent = "已复制";
        setTimeout(function() { e.target.textContent = "复制"; }, 1500);
      });
    });
    card.querySelector('[data-act="view"]').addEventListener("click", function() {
      if (rec.images && rec.images[0]) {
        var im = rec.images[0];
        window.open("/api/view?filename=" + encodeURIComponent(im.filename) + "&subfolder=" + encodeURIComponent(im.subfolder||"") + "&type=output", "_blank");
      }
    });
    var thumbEl = card.querySelector(".gen-history-thumb");
    if (thumbEl) thumbEl.addEventListener("click", function() {
      if (rec.images && rec.images[0]) {
        var im = rec.images[0];
        window.open("/api/view?filename=" + encodeURIComponent(im.filename) + "&subfolder=" + encodeURIComponent(im.subfolder||"") + "&type=output", "_blank");
      }
    });
  });
}

/* 清空历史 */
var clearBtn = document.getElementById("genHistoryClear");
if (clearBtn) {
  clearBtn.addEventListener("click", function(e) {
    e.stopPropagation();
    if (!confirm("确定清空所有生成历史？")) return;
    fetch("/api/genhistory/clear", { method: "POST" }).then(function() { loadGenHistory(); });
  });
}

/* 页面加载时加载历史 */
loadGenHistory();

/* ---------- 图生图 ---------- */
state.img2imgEnabled = false;
state.img2imgImage = null;
state.denoise = 0.65;

var img2imgEnable = document.getElementById("img2imgEnable");
var img2imgBody = document.getElementById("img2imgBody");
var img2imgHint = document.getElementById("img2imgHint");
var img2imgFile = document.getElementById("img2imgFile");
var img2imgPreview = document.getElementById("img2imgPreview");
var img2imgFileHint = document.getElementById("img2imgFileHint");
var denoiseSlider = document.getElementById("denoiseSlider");
var denoiseVal = document.getElementById("denoiseVal");

if (img2imgEnable) {
  img2imgEnable.addEventListener("change", function() {
    state.img2imgEnabled = img2imgEnable.checked;
    img2imgBody.style.display = state.img2imgEnabled ? "flex" : "none";
    img2imgHint.style.display = state.img2imgEnabled ? "inline" : "none";
  });
}

if (img2imgFile) {
  img2imgFile.addEventListener("change", function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      var b64 = ev.target.result;
      // 显示预览
      img2imgPreview.src = b64;
      img2imgPreview.style.display = "block";
      img2imgFileHint.style.display = "none";
      // 上传到后端
      fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, data: b64, subdir: "img2img" }),
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.path) {
          state.img2imgImage = d.path;
          img2imgFileHint.textContent = "已上传：" + d.filename;
          img2imgFileHint.style.display = "inline";
        } else {
          img2imgFileHint.textContent = "上传失败：" + (d.error || "未知错误");
          img2imgFileHint.style.display = "inline";
        }
      }).catch(function(err) {
        img2imgFileHint.textContent = "上传失败：" + err.message;
        img2imgFileHint.style.display = "inline";
      });
    };
    reader.readAsDataURL(file);
  });
}

if (denoiseSlider) {
  denoiseSlider.addEventListener("input", function() {
    state.denoise = parseFloat(denoiseSlider.value);
    denoiseVal.textContent = state.denoise.toFixed(2);
  });
}

/* ---------- 提示词模板 ---------- */
var templates = [];
var templateSelect = document.getElementById("templateSelect");
var templateApply = document.getElementById("templateApply");
var templateSave = document.getElementById("templateSave");
var templateDelete = document.getElementById("templateDelete");

async function loadTemplates() {
  try {
    var r = await fetch("/api/templates/list");
    var d = await r.json();
    templates = d.items || [];
    renderTemplateSelect();
  } catch (e) { /* ignore */ }
}

function renderTemplateSelect() {
  if (!templateSelect) return;
  templateSelect.innerHTML = '<option value="">选择模板…</option>';
  templates.forEach(function(tpl) {
    var opt = document.createElement("option");
    opt.value = tpl.id;
    opt.textContent = tpl.name + (tpl.positive ? "（" + tpl.positive.substring(0, 20) + "…）" : "");
    templateSelect.appendChild(opt);
  });
  updateTemplateButtons();
}

function updateTemplateButtons() {
  var hasSelection = templateSelect && templateSelect.value !== "";
  if (templateApply) templateApply.disabled = !hasSelection;
  if (templateDelete) templateDelete.disabled = !hasSelection;
}

if (templateSelect) {
  templateSelect.addEventListener("change", updateTemplateButtons);
}

if (templateApply) {
  templateApply.addEventListener("click", function() {
    var id = parseInt(templateSelect.value);
    var tpl = templates.find(function(x) { return x.id === id; });
    if (!tpl) return;
    if (tpl.positive) document.getElementById("positive").value = tpl.positive;
    if (tpl.negative) document.getElementById("negative").value = tpl.negative;
    // 应用参数（如果有）：直接写回 state 并刷新高亮
    if (tpl.width && tpl.height) {
      var sizeObj = SIZES.find(function(s) { return s.w === tpl.width && s.h === tpl.height; });
      if (sizeObj) state.size = sizeObj.id;
    }
    if (tpl.steps) {
      state.steps = tpl.steps;
      var stepsRange = document.getElementById("stepsRange");
      if (stepsRange) stepsRange.value = tpl.steps;
      var stepsVal = document.getElementById("stepsVal");
      if (stepsVal) stepsVal.textContent = tpl.steps;
    }
    if (tpl.cfg) state.cfg = tpl.cfg;
    refreshActive();
    // 不能调用 compile()：否则会覆盖模板里保存的提示词
    templateApply.textContent = "已应用";
    setTimeout(function() { templateApply.textContent = "应用"; }, 1500);
  });
}

if (templateSave) {
  templateSave.addEventListener("click", async function() {
    var name = prompt("输入模板名称：", "我的模板 " + new Date().toLocaleString());
    if (!name) return;
    try {
      var r = await fetch("/api/templates/add", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name,
          positive: document.getElementById("positive").value,
          negative: document.getElementById("negative").value,
          width: state.size ? SIZES.find(function(s) { return s.id === state.size; }).w : null,
          height: state.size ? SIZES.find(function(s) { return s.id === state.size; }).h : null,
          steps: state.steps,
          cfg: state.cfg,
        }),
      });
      await r.json();
      await loadTemplates();
      templateSave.textContent = "已保存";
      setTimeout(function() { templateSave.textContent = "保存当前为模板"; }, 1500);
    } catch (e) {
      alert("保存失败：" + e.message);
    }
  });
}

if (templateDelete) {
  templateDelete.addEventListener("click", async function() {
    var id = parseInt(templateSelect.value);
    if (!id) return;
    if (!confirm("确定删除此模板？")) return;
    try {
      await fetch("/api/templates/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: id }),
      });
      await loadTemplates();
    } catch (e) {
      alert("删除失败：" + e.message);
    }
  });
}

loadTemplates();

/* ---------- 主题切换 ---------- */
var themeToggle = document.getElementById("themeToggle");
function applyTheme(theme) {
  if (theme === "light") {
    document.body.classList.add("light");
    if (themeToggle) themeToggle.textContent = "☀️ 浅色";
  } else {
    document.body.classList.remove("light");
    if (themeToggle) themeToggle.textContent = "🌙 深色";
  }
}
var savedTheme = localStorage.getItem("nsfw-theme") || "dark";
applyTheme(savedTheme);
if (themeToggle) {
  themeToggle.addEventListener("click", function() {
    var isLight = document.body.classList.contains("light");
    var newTheme = isLight ? "dark" : "light";
    applyTheme(newTheme);
    localStorage.setItem("nsfw-theme", newTheme);
  });
}
