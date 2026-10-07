# NSFW Studio · 本地图像控制台

把 nsfw-prompt 技能的规则做成**图形界面**：点选主体、暴露档位、场景、姿势（含手部锁）、
灯光、胶片和参数，实时看到编译好的英文提示词，一键驱动本地 ComfyUI（Qwen-Image-2.1 破甲版）出图。

- 纯本地运行，只监听 `127.0.0.1:8189`，不对外暴露；
- 控制台本身不画图，只把工作流提交给本机 ComfyUI（`127.0.0.1:8188`）；
- 图片照常由 ComfyUI 保存到 `projects\comfyui\app\output\nsfw-studio\日期\`。

## 功能一览

- **生成**：图形点选编译提示词 / 锁脸参考图 / 服饰参考图 / 图生图 / 4x 高清放大；
- **图库**：瀑布流 + 全量搜索 + 收藏筛选 + 看图器（滚轮围绕光标缩放、拖动、双击放大、触屏双指）+ 对比视图；
- **人脸库 / 服饰库**：从图库收录或上传、重命名、使用计数；
- **提示词库**：保存 / 导入 / 导出编译好的提示词；
- **内部批量**：多条提示词排队逐张生成；刷新页面自动接管运行中任务；停止 / 断点续跑（按种子跳过已生成图）/ 删除保护；
- **外部千问批量控制**：启动 / 优雅停止 `comfyui` 项目的分段批量脚本（每段张数、起始段可配；
  停止＝当前张跑完即退出、已生成图保留、可续跑；单实例保护；崩溃后自动识别残留标记）。

## 启动

1. 先确保 ComfyUI 已启动（计划任务 `\AIHome\ComfyUI`，或控制中心）。
2. 双击本目录的 **`start.bat`**，会自动打开浏览器到 http://127.0.0.1:8189 。
3. 关闭命令行窗口即停止控制台服务（不影响 ComfyUI）。

> AIHome 环境下亦由计划任务 `\AIHome\NSFWStudio` 承载并由 ControlHub 管理生命周期。
> 修改 `server.py` 后需重启服务生效；仅改前端（static/）浏览器 F5 即可。

## 在新电脑上继续开发

**依赖与路径要求**

- **Python**：与 ComfyUI 共用虚拟环境（`projects/comfyui/venv`，含 `requests`）。
  server.py 仅用标准库 + `requests`，无其他第三方依赖。
- **目录布局**：本项目假定与 `comfyui` 项目**同级**（`projects/nsfw-studio` 与 `projects/comfyui` 并列）。
  `server.py` 中的 `COMFY_ROOT` / `COMFY_PROJECT` 等常量按 `..\comfyui\...` 相对解析；
  若布局不同，需改这些常量与 `start.bat` 里的 `PY` 路径。
- **模型**：ComfyUI 侧的千问模型（GGUF / CLIP / VAE）体积过大，不随仓库携带，需在新机器自行准备。
- **外部批量脚本**：`comfyui\temp\qwen_batch20.py` 属于 comfyui 项目，也不在本仓库；
  其与控制台的启停协议（停止标志文件 + 运行标记心跳）见该脚本头部注释。

**运行**

- 直接运行：`<comfyui>\venv\Scripts\python.exe server.py`（或改好路径后的 `start.bat`）；
- 就绪探针：`http://127.0.0.1:8189/health/ready`（返回 `{"service":"nsfw-studio","ready":true}`）。

**数据**

- `runtime/*.json`（提示词库 / 收藏 / 人脸 / 服饰 / 模板 / 生成历史）为**本地运行数据**（本镜像不携带，首次运行自动创建）；
- 缓存（`runtime/thumbs`、`runtime/prompt_cache.json`）、日志与批量任务记录**不入库**，运行后自动重建。

## 给 AI 审阅（前端 / 全项目）

- 本仓库为**纯代码公开镜像**（不含运行数据、内部交接记录与 ComfyUI 侧资产）；可直接在线阅读或 Clone。
- **请先让 AI 读 [`ARCHITECTURE.md`](ARCHITECTURE.md)**：文件职责表、前端页面地图、核心机制
  （统一编号 / 断点续跑 / 提示词规范）、48 条 API 路由表、已知过渡态（避免误报为缺陷）；
- 快速导出审阅包（只含入库文件，无缓存与私有产物）：
  `git archive --format=zip --prefix=nsfw-studio/ -o review.zip HEAD`

## 使用

1. 左侧依次点选：主体外貌、身材、暴露档位（L1–L5）、场景、姿势、神情、灯光、镜头胶片；
   - 选 **L5 全裸**时会解锁「L5 子档」S1–S3；
   - **手部最稳的是「肢体锁」姿势**，高暴露档建议用它。
2. 下方设置尺寸、张数（1–8，串行逐张不爆显存）、步数、CFG、种子；
3. 右侧实时显示编译出的正面 / 负面提示词，也可手动修改；
4. 点「生成」，逐张出图并显示，可点「中断」取消；图片下方可单张下载。

## 内容边界

仅限**成年人、自愿、虚构角色**的本地个人创作，遵守当地法律与平台条款。
不生成未成年内容、不针对真实私人、不生成非自愿性暴力内容。

## 目录

```
README.md         项目说明与运行方法
ARCHITECTURE.md   AI 审阅指南：结构 / 页面地图 / 机制 / API 路由表 / 已知过渡态
server.py         后端：静态托管 + ComfyUI 代理 + 批量控制 API（标准库 + requests）
batch_worker.py   内部批量的队列 / 断点续跑 worker（被 server.py 调用）
tools/            prompt_pack.py：提示词包校验与清单工具（统一编号分配）
start.bat         双击启动
static/           index.html / nav.js / gencenter.js（生成中心）/ app.js（控制台编译引擎）/
                  batch.js / gallery.js / faces.js / outfits.js / promptlib.js /
                  data*.js（关键词芯片数据）/ style.css
runtime/          运行数据目录（本地生成、不入库）：提示词库 / 收藏 / 历史 / 模板等 *.json
```

## 开发记录

`docs/` 下为完整交接文档：

- `2026-09-26-nsfw-studio-handoff.md`：ControlHub 接入与生命周期验证；
- `2026-09-28-nsfw-studio-bugfix.md`：自 2026-09-28 起 11 轮修复与实测记录
  （批量启停协议、断点续跑命名规则、看图器实现、已知限制与未验证项等）。