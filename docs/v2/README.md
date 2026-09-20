# PXD V2 · LS Studio 规划入口

更新：2026-09-20。状态：**待用户审阅；本轮只更新文档，尚未启动实施 subagent。**

决定：在现有 [lianshuang-photo/PXD](https://github.com/lianshuang-photo/PXD) 仓库管理下一代产品，产品名保留 **LS Studio**，以 **PXD V2** 标识本轮产品演进。使用独立 worktree；确认后将当前 LS Alpha 导入 `apps/ls-studio/`，保持旧 PXD 根目录应用可辨识。

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
| [文档同步规则](DOCUMENTATION.md) | 哪份是主文档，怎样避免 Downloads、GitHub、历史记录相互冲突 |

背景资料：[轮椅能力审计](research/Wheelchair-LS-Capability-Audit-2026-09-12.md)、[COS 原片到发布研究](research/Cosplay-RAW-to-Publish-Workflow.md)、[双 Skill 的职责](research/Skill-Architecture-History.md)。旧接口见 [Alpha 作业接口](reference/Alpha-IDE.md) 和 [Alpha 配方接口](reference/Alpha-Recipes.md)。

## 当前事实

- GitHub PXD main 基线：`3c9fc7d25f0b9691346b5fdc0197a6e99305c676`，2026-07-16。根目录应用是 React／TypeScript PXD，包版本 0.2.0。
- 当前可试用 LS Alpha：独立目录中的 0.1.5，UXP HTML／JavaScript 面板＋Node Companion。Codex 会话、恢复、渲染、PS 观察／定位已经接入。
- LS 正式 Agent 工具仍为 7 个；编辑／生成／回贴工具尚未接通。专业页仍用 mock，并有源文档、蒙版、撤销和历史输入等缺陷。
- 121 份配方属于提示词数据；旧 PXD 的代码和已合并 PR 属于复用候选，均不计为 LS 的交付。
- 本规划分支只包含文档。`apps/ls-studio/` 是确认后的导入目标，当前还不存在。`V2` 是产品代际，未把 Alpha 包版本改成 2.0.0。

## 本轮交付与启动条件

已完成仓库评估、GitHub 状态核对、文档统一和实施拆分。当前代码状态只做静态复核；未把历史测试结果写成本轮重新测试通过。

用户阅读确认后，主 agent 执行 G00／G01，再按 [实施计划](EXECUTION-PLAN.md) 启动有明确文件所有权的 subagent。此次文档 PR 的创建、可阅读或合并状态，不自动代表用户已经授权启动开发。
