# PXD V2 · LS Studio 规划入口

更新：2026-09-20。状态：**#52–#58 基础模块及 #59–#61 三项功能 PR 已通过当前 CI；#50／#51 已关闭且未合并，真实 Photoshop／UXP 验收仍不完整。** 见[模块 PR 索引](MODULAR-DELIVERY.md)、[实施状态](IMPLEMENTATION-STATUS.md)与[协作规则](COLLABORATION.md)。CI 记录绑定已观察的提交，新提交需重新检查。

决定：在现有 [lianshuang-photo/PXD](https://github.com/lianshuang-photo/PXD) 仓库管理下一代产品，产品名保留 **LS Studio**，以 **PXD V2** 标识本轮产品演进。使用独立 worktree；当前 LS Alpha 已导入 `apps/ls-studio/` 并以 `ls-studio-v2-alpha.0` 标签保留，旧 PXD 根目录应用保持独立。

## 建议阅读顺序

| 文档 | 回答的问题 |
|---|---|
| [工作区与仓库决策](WORKSPACE-DECISION.md) | 为什么用原仓库、源码放哪里、现有插件怎样迁移 |
| [PRD](PRD-LS-Studio.md) | 产品目标、范围、用户操作与 Agent 如何接续、怎样算完成 |
| [路线图](ROADMAP.md) | 分阶段交付及依赖；哪些能力属于后续阶段 |
| [能力台账](CAPABILITY-MATRIX.md) | B01–B36 全部保留，当前状态、验收点和交付阶段 |
| [共享架构与契约](ARCHITECTURE.md) | Asset、EditContext、Job、回贴回执与 UI／Agent 的共用接口 |
| [实施与 subagent 分工](EXECUTION-PLAN.md) | 确认后怎样拆任务、文件所有权、集成和验证顺序 |
| [旧 PXD 复用清单](LEGACY-REUSE.md) | main 中已有资产、未合并 PR，以及复用边界 |
| [验收基线](VALIDATION.md) | 已有证据与未来必须通过的检查 |
| [CI/CD 与发布](CI-CD.md) | PR 检查、可下载产物、审核与真机证据门禁 |
| [模块交付索引](MODULAR-DELIVERY.md) | 每个 PR 的范围、比较基底、准确 head、CI 和真机边界 |
| [功能组装浏览器证据](evidence/2026-09-20-feature-browser.md) | 合成素材下实际点击了哪些功能，哪些仍未验证 |
| [文档同步规则](DOCUMENTATION.md) | 哪份是主文档，怎样避免 Downloads、GitHub、历史记录相互冲突 |

背景资料：[轮椅能力审计](research/Wheelchair-LS-Capability-Audit-2026-09-12.md)、[COS 原片到发布研究](research/Cosplay-RAW-to-Publish-Workflow.md)、[双 Skill 的职责](research/Skill-Architecture-History.md)。旧接口见 [Alpha 作业接口](reference/Alpha-IDE.md) 和 [Alpha 配方接口](reference/Alpha-Recipes.md)。

## 当前事实

- GitHub PXD main 基线：`3c9fc7d25f0b9691346b5fdc0197a6e99305c676`，2026-07-16。根目录应用是 React／TypeScript PXD，包版本 0.2.0。
- 当前可试用 LS Alpha：独立目录中的 0.1.5，UXP HTML／JavaScript 面板＋Node Companion。Codex 会话、恢复、渲染、PS 观察／定位已经接入。
- V2 0.1.6 的专业页和 Agent 已接到同一套草稿／任务服务。#58 基础树提供 17 个 Studio 工具和 7 个 PS 工具；私有三功能组装 `6121333dd4fe9f99a065c2d7e76920bcf88b1992` 提供 33 个 MCP 工具。两个数字描述不同源码范围。首批执行能力为图像编辑及已有层的名称／不透明度／可见性；真实供应商生成仍待验收。
- 121 份配方的内容、101 个数值参数及来源哈希已接入共享草稿。旧 PXD 其他玩法仍是复用候选，不能计为本轮交付。
- 实施已拆分为 [#52–#58 模块 PR](MODULAR-DELIVERY.md)，结果比较／修订草稿、B05 预设、Provider 设置分别在 [#59](https://github.com/lianshuang-photo/PXD/pull/59)、[#60](https://github.com/lianshuang-photo/PXD/pull/60)、[#61](https://github.com/lianshuang-photo/PXD/pull/61)。本 #58 文档树不含三个功能实现，细节从对应 PR 阅读。
- #50／#51 已关闭并被替代，保留历史记录，没有合并；Alpha 固定在 `ls-studio-v2-alpha.0`，已安装服务未替换。`V2` 是产品代际，包版本仍为 0.1.6。

## 本轮交付与启动条件

已完成仓库评估、Alpha 保留、首批模块和三项功能实现、内部交叉 review 与私有组装。最新组装 240 pass／0 fail／1 项 launchd 生命周期明确跳过（总 241），78 JS 检查、clean build 和实际解压 smoke 通过。基础分支历史 193 项通过记录保持独立，各模块／功能计数不相加。

早期真实 Photoshop 的抓图、羽化蒙版、组合属性修改、撤销及后续修改冲突已有[部分宿主记录](evidence/2026-09-20-host-partial.md)。本轮原生 Chrome/CUA 以隔离数据和合成图像验证结果派生／比较、预设管理、默认值／模型设置及 100–200% 缩放，见[浏览器记录](evidence/2026-09-20-feature-browser.md)。两份记录属于不同提交与环境，不能互相继承，也没有把浏览器结果标为宿主成功。

G08 尚未通过；B05 实现完成、待宿主验收，B06 和 G10 之后未开始，G09／M1／M2 均未通过。所有 live status 保持 pending，内部审查不能替代 GitHub 独立账号 approve。main 保护与发布门禁保持启用；三个功能 PR 待依赖进入 main 后 retarget／更新并重做审批、检查和精确提交真机证据，不合入临时比较分支。后续按[实施计划](EXECUTION-PLAN.md)推进。
