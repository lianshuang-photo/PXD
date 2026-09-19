# 文档权威与同步

更新：2026-09-20。

## 主来源

PXD 仓库的 `docs/v2/` 是规划与实施状态的主来源。规划 PR #50 保持文档范围；用户已明确确认启动，后续在实施分支更新。用户确认、模块测试通过和 main 合并是不同状态；合并仍须满足独立 review、自动化和 computer use 真机门禁。

| 内容 | 主文档 | 修改要求 |
|---|---|---|
| 仓库／目录与迁移 | WORKSPACE-DECISION.md | 记录实际已做与计划动作，避免假装已迁移 |
| 产品范围和用户行为 | PRD-LS-Studio.md | 能力台账同步；不以技术阶段删范围 |
| B01–B36 的状态 | CAPABILITY-MATRIX.md | 状态改变附 PR／commit 和验收证据 |
| 阶段顺序和依赖 | ROADMAP.md | 实施计划同步，标注未启动或未验证 |
| 数据／接口与执行边界 | ARCHITECTURE.md | 新接口由主 agent 统一，worker 不复制另一套 |
| 任务拆分与文件所有权 | EXECUTION-PLAN.md | 每次派发更新依赖和所有者，不自动启动远期模块 |
| 已有代码来源 | LEGACY-REUSE.md | 基线使用固定 commit；合并状态按 GitHub 核对日期 |
| 测试和真实结果 | VALIDATION.md | 历史结果、本轮结果、未验证项分开 |

## Alpha 目录同步方式

迁移前曾把同一套 `docs/v2/` 镜像到 Alpha 的 `docs/v2/`。G00 已导入源码，现按用户要求完整保留旧 Alpha，停止继续改写该镜像；当前文档只在 GitHub 的实施分支推进。

Alpha 原 `docs/PRD-LS-Studio.md` 改为指向新 PRD 的入口，README 更新范围和当前运行事实，旧 `companion/ide.md`／`recipes.md` 改为明确的 Alpha 接口记录。原 PRD／README／接口文件保留在本机带日期的归档目录，不能再次被误当成 V2 限制。

原研究与验证记录保留原日期和证据，顶部补上新文档入口。公开版研究移除个人绝对路径、私人任务标识与完整运行日志，只保留来源标识与公共材料；原始本机证据不删除。

`apps/ls-studio/README.md` 已链接根 `docs/v2/`，不再次复制整个规划树到应用里。Downloads 是来源快照；正式工作区与保留标签见 [COLLABORATION.md](COLLABORATION.md)。

## 同步检查

- B01–B36 全部且仅出现一次主表记录；每条有当前状态、交付阶段和验收依据。
- README／PRD／路线图／接口历史不再把 Forge、ComfyUI、人体、批量等写成 V2 永久排除项。
- 所有本地 Markdown 链接可在仓库中解析；历史未导入代码用路径说明，不制造不存在的可点击链接。
- 公开文档不依赖个人绝对路径或私人任务链接；真实密钥、图片、PSD、会话和日志不进入提交。
- 当前实现与规划 API 区分；源代码迁移、测试通过、用户确认和 PR 合并分别记录。
