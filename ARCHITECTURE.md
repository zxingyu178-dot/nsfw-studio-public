# ARCHITECTURE · AI 审阅指南

> 本文档面向"**用 AI 审阅本项目**"的场景：任何 AI 只需先读本文件 + `README.md`，即可理解整体结构、
> 前端页面划分、数据流、API 面与关键约定，无需先通读全部代码。
>
> 建议阅读顺序：`README.md` → 本文件 §1–§5 → `static/index.html`（页面骨架）→
> `static/gencenter.js` → `static/batch.js` → `static/app.js` → `server.py`（API 面）→ `static/gallery.js`。

---

## 1. 项目是什么

**NSFW Studio**：单机、纯本地运行的图像生成控制台（成人内容边界见 README，仅限 127.0.0.1，不对外暴露）。

- 前端 = 关键词点选 → 实时编译提示词 → 提交生成 → 图库管理（**纯原生 HTML/CSS/JS，无框架、无构建步骤**）；
- 后端 = 一个标准库 `http.server` 单文件（`server.py`）+ 批量队列 worker（`batch_worker.py`）；
- 生成引擎 = 本机 ComfyUI（`127.0.0.1:8188`，Qwen-Image-2.1 破甲版），控制台只提交工作流并轮询结果；
- 无数据库：全部状态为 `runtime/*.json` 小文件。

## 2. 技术栈与运行

| 层 | 技术 | 说明 |
|----|------|------|
| 前端 | 原生 JS（IIFE，无模块/打包）、`fetch`、CSS 变量主题（`:root` 深色 / `body.light` 浅色） | 打开页面即运行，有 DOM 钩子 `window.xxxRefresh` |
| 后端 | Python 标准库 `http.server` + `requests` | 单文件 `server.py`（约 1700 行），全部 API 在 `do_GET` / `_handle_post` |
| 引擎 | ComfyUI HTTP API | 提交 `/prompt`、轮询 `/history/<id>`、取图 `/view` |
| 运行 | `<venv>\python.exe server.py`（监听 8189）；就绪探针 `/health/ready` | 仅改前端浏览器 F5；改后端需重启服务 |

## 3. 文件职责（纯代码集，共 22 个文件）

```
server.py            后端全部：静态托管 + JSON API + ComfyUI 代理 + 批量控制（§6 路由表）
batch_worker.py      内部批量队列 worker：串行逐张执行、断点续跑（按 _s<种子>_ 跳过已生成）、任务持久化到 runtime/batch/
tools/prompt_pack.py 提示词包工具（check 校验 / init 生成 manifest，统一编号分配；见 §5.3）
start.bat            双击启动（自动开浏览器）

static/index.html    页面骨架：6 个 <main class="page" id="page-xxx">（gencenter/console/batch/gallery/faces/outfits/promptlib）
static/nav.js        主标签切换 showPage(id) + 各页刷新钩子（默认页 = 生成中心）
static/gencenter.js  生成中心：四来源（手写/关键词拼接/库/AI包）+ 参数 + 参考图（锁脸：人脸库/上传）+ 任务中心（轮询渲染进度/缩略图/停止/继续）+ 库条目查重
static/app.js        控制台：关键词芯片引擎（state / renderOptions / compile）+ 锁脸/图生图/放大 + 生成历史 + 图库（高清）
static/batch.js      批量生图页：草稿列表（localStorage 持久化）/ 弹窗编辑 / 提示词库导入 / 任务进度控制 / 外部脚本启停面板
static/gallery.js    图库页：瀑布流 + 全量搜索（缓存/防抖）+ 收藏筛选 + 看图器（滚轮围绕光标缩放/拖动/双击/双指）+ 对比视图
static/faces.js      人脸库页（收录/上传/改名/使用）
static/outfits.js    服饰库页
static/promptlib.js  提示词库页（保存/导入目录/导出/加载到控制台）
static/data.js       芯片元数据（分组定义、编译模板、负面词库）
static/data_body.js  芯片数据：身材/暴露档位（L1–L5）/手部/神情等
static/data_face.js  芯片数据：主体外貌/年龄等
static/data_wardrobe.js  芯片数据：服饰/穿搭
static/data_world.js 芯片数据：场景/灯光/胶片镜头
static/style.css     全部样式（主题变量、各页布局、组件）
runtime/*.json       运行数据随仓库携带：promptlib / favorites / faces / outfits / templates / history
                     （缓存 thumbs / logs / batch 任务记录 / prompt_cache / id_pool 不入库，运行后重建）
```

## 4. 前端页面地图（审阅重点）

导航：`nav.js` 按 `data-page` 切换；页面 = `<main class="page" id="page-<名>">`；**默认页为生成中心**。

### 4.1 生成中心 `page-gencenter`（gencenter.js）——统一生成入口

- **四来源**（`#gcSourceSeg`）：`manual` 手写 / `keyword` 关键词拼接 / `library` 提示词库 / `pack` AI 提示词包；
- `keyword` 的编译面板 `#optionsPanel` **由 app.js 渲染**（与控制台共用同一份实现，DOM 物理位于生成中心）；
  编译输出由 `compile(writeTo)` 写入本页提示词框（`#gcPositive/#gcNegative`），控制台本地流程传 `"console"`；
- 参数区 `#gcSize/#gcCount/#gcSteps/#gcCfg/#gcName/#gcCategory`（控件已主题化，非系统原生外观）；
- 提交 → `POST /api/gen/submit`（服务端分配全局 ID，见 §5.2），提示显示编号与输出目录；
- `library` 选中条目 → `POST /api/gen/lookup` 精确匹配历史与批量任务 → 右侧 `#gcExisting` 显示"该提示词已生成的图片"；
- `pack` → `GET /api/gen/pack` 渲染包清单（完成度 x/N）→ `POST /api/gen/pack/submit` 提交内部批量；
- **任务中心**（右侧）：轮询 `/api/batch/status`（列表）+ `?id=`（详情），渲染进度卡 `#gcStatus`、缩略图流 `#gcGallery`、历史 `#gcHistory`、外部脚本状态行 `#gcExtLine`。

### 4.2 控制台 `page-console`（app.js）——高级生成

- 关键词编译面板已移至生成中心；本页保留：锁脸 / 图生图 / 服饰参考、手填提示词生成、4x 放大、高清画廊与历史；
- 其生成按钮走旧命名（日期目录），属**过渡态**（见 §7）。

### 4.3 批量生图 `page-batch`（batch.js）

- 草稿条目（localStorage `nsfwstudio.batch.draft.v1`）→ `POST /api/batch/create`；
- 刷新自动接管运行中任务；停止 / 继续（断点续跑）/ 删除保护；外部千问脚本启停面板（`/api/batch/external*`）。

### 4.4 图库 `page-gallery`（gallery.js）

- 瀑布流（真实宽高计算跨行）、搜索（500ms 防抖 + 缓存 + 负缓存）、收藏、看图器（panzoom 范式）、对比视图。

## 5. 核心机制与约定

### 5.1 生成链路

```
浏览器 → server.py 组装工作流(JSON) → ComfyUI /prompt → 轮询 /history/<id> → 图存 ComfyUI output 目录
                                                     → /api/view、/api/thumb 取图（浏览器 <img>）
```

### 5.2 统一编号体系（P2 起，生成中心与外部脚本一致）

- **条目 ID 全局唯一、永不复用**：提示词包条目 1–999（`manifest.json` 分配）；散图（手写/模板/库）从 **1000 起**（`runtime/id_pool.json` 计数器）；
- **种子** `seed_base = 180000 + ID×100`，第 j 张 = seed_base + (j-1)；
- **输出**：目录 `分类/<ID>_<名称>/`（包条目为 `千问批量/<文件stem>/`）；文件名 `<ID>_第<NN>张_s<种子>_<计数器>.png`；
- **断点续跑**：按 `目录 + _s<种子>_` 匹配跳过已生成（`batch_worker._item_prefix` / `_image_exists`）；
  内部 worker 与外部 `qwen_batch20.py` 产物**同命名体系，可互相续跑**。

### 5.3 提示词文件规范 v1（Prompt Spec v1）

`<分类>_<编号>_<标题>.txt`；内容：`#` 注释行（标题/标签）→ 正面词 → `NEG:`（兼容全角）→ 负面词（可空）。
解析实现三处一致：`qwen_batch20.py::parse_prompt`、`tools/prompt_pack.py::analyze_file`、`server.py::parse_prompt_txt`。

### 5.4 任务系统

`batch_worker` 维护任务字典（status: pending/running/done/cancelled/error/failed），持久化 `runtime/batch/<id>.json`；
前端只读 `/api/batch/status` 渲染，不持有状态（刷新即恢复）。

## 6. HTTP API 一览（server.py，共 48 条路由）

**GET**：`/`（页面）、`/health/ready`、`/api/system`、`/api/history`、`/api/view`、`/api/prompt`、`/api/thumb`、`/api/queue`、
`/api/gallery/dirs`、`/api/gallery/list`（支持 search）、`/api/favorites/list`、`/api/genhistory/list`、`/api/templates/list`、
`/api/batch/status`（可带 `?id=`）、`/api/batch/external`、`/api/gen/pack`（可带 `?dir=`）、`/api/promptlib/list`、
`/api/faces/list`、`/api/outfits/list`

**POST**：`/api/upload`、`/api/generate`、`/api/upscale`、`/api/interrupt`、
`/api/gallery/delete`、`/api/gallery/upscale`、`/api/favorites/toggle`、`/api/genhistory/add`、`/api/genhistory/clear`、
`/api/templates/add`、`/api/templates/delete`、`/api/promptlib/save`、`/api/promptlib/import_dir`、
`/api/faces/add|upload|rename|delete|use`、`/api/outfits/add|upload|rename|delete|use`、
`/api/batch/create|cancel|delete`、`/api/batch/external/start|stop`、
`/api/gen/submit`、`/api/gen/lookup`、`/api/gen/pack/submit`

> 约定：JSON 请求/响应；`{"ok": true/false, "error": "..."}`；静态文件响应头 `no-store`（改前端 F5 必生效）。

## 7. 已知问题与过渡态（审阅时请知悉，勿误报为缺陷）

1. **控制台生成按钮仍用旧命名**（日期目录 + 时间种子）——新规范只在生成中心/包任务生效（渐进迁移中）；
2. **`build_prompt` 存在两份**（`server.py` 控制台链路 / `batch_worker.py` 批量链路）——有意分开：两者现已都支持锁脸 / 服饰参考（工作流逐字节等价，有等价性测试脚本）；图生图仍仅控制台支持；
3. **查重为精确文本匹配**（归一化空白），生成前临时改词会查不到旧图（显示"暂无生成记录"）；
4. **`.gallery` 瀑布流容器需要 JS 计算行跨行**（`grid-auto-rows:6px`），生成中心因此使用独立 `.gc-grid`；
5. PowerShell 5.1 `Invoke-RestMethod -Body <字符串>` 发送中文会变 `?`——测试脚本须用 UTF-8 字节（本项目测试脚本在 `temp/`，不入库）；
6. 外部批量脚本 `qwen_batch20.py`（属 comfyui 项目，不在本仓库）：与控制台的启停协议 = 停止标志文件 + 运行标记心跳。

## 8. 本地运行与验证

```bat
:: 1) 启动 ComfyUI（8188）  2) 启动控制台：
start.bat
:: 就绪探针： http://127.0.0.1:8189/health/ready
```

前端自动化验证：headless Chrome + CDP 脚本（在 `temp/`，不入库），端口须避开本机保留段（`9338-9437`）。

## 9. 仓库边界（本仓库不含什么）

- **ComfyUI 项目**（模型 GGUF/CLIP/VAE、venv、外部批量脚本、提示词包目录）不在本仓库；
- **运行缓存与私有产物**不入库：缩略图缓存、日志、批量任务记录、提示词缓存、编号池计数器、`temp/`；
- 本仓库为**纯代码公开镜像**：不含运行数据（runtime/*.json）、内部交接文档（docs/）与 ComfyUI 侧资产（模型 / venv / 外部批量脚本 / 提示词包）。