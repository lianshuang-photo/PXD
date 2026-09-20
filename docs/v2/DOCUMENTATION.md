# 文档权威与同步

更新：2026-09-21。

## 主来源

PXD 仓库的 `docs/v2/` 是本轮规划主来源。目前在 `codex/pxd-v2-planning` 分支供审阅；只有用户审阅和合并后的版本才进入仓库 main。不能把 draft PR 已建立写成计划已获批准。

| 内容 | 主文档 | 修改要求 |
|---|---|---|
| 前后端开发、联调与 PR 质量规范 | [ENGINEERING-STANDARDS.md](../../ENGINEERING-STANDARDS.md) | AGENTS.md 强制读取；变更同步 PR 模板与验收记录模板，避免个人 Skill 形成副本 |
| 仓库／目录与迁移 | WORKSPACE-DECISION.md | 记录实际已做与计划动作，避免假装已迁移 |
| 产品范围和用户行为 | PRD-LS-Studio.md | 能力台账同步；不以技术阶段删范围 |
| B01–B36 的状态 | CAPABILITY-MATRIX.md | 状态改变附 PR／commit 和验收证据 |
| 阶段顺序和依赖 | ROADMAP.md | 实施计划同步，标注未启动或未验证 |
| 数据／接口与执行边界 | ARCHITECTURE.md | 新接口由主 agent 统一，worker 不复制另一套 |
| 任务拆分与文件所有权 | EXECUTION-PLAN.md | 每次派发更新依赖和所有者，不自动启动远期模块 |
| 已有代码来源 | LEGACY-REUSE.md | 基线使用固定 commit；合并状态按 GitHub 核对日期 |
| 测试和真实结果 | VALIDATION.md | 历史结果、本轮结果、未验证项分开 |

## Alpha 目录同步方式

迁移前仍需用户在当前 LS 目录阅读，所以把同一套 `docs/v2/` 镜像到 Alpha 的 `docs/v2/`。镜像文件逐字一致，编辑主工作区再单向同步；不在两个目录分别推进内容。

Alpha 原 `docs/PRD-LS-Studio.md` 改为指向新 PRD 的入口，README 更新范围和当前运行事实，旧 `companion/ide.md`／`recipes.md` 改为明确的 Alpha 接口记录。原 PRD／README／接口文件保留在本机带日期的归档目录，不能再次被误当成 V2 限制。

原研究与验证记录保留原日期和证据，顶部补上新文档入口。公开版研究移除个人绝对路径、私人任务标识与完整运行日志，只保留来源标识与公共材料；原始本机证据不删除。

G00 后 `apps/ls-studio/README.md` 链接根 `docs/v2/`，不再次复制整个规划树到应用里。Downloads 变为来源快照，停止持续镜像；在入口文档中标明正式工作区。

## 同步检查

- B01–B36 全部且仅出现一次主表记录；每条有当前状态、交付阶段和验收依据。
- README／PRD／路线图／接口历史不再把 Forge、ComfyUI、人体、批量等写成 V2 永久排除项。
- 所有本地 Markdown 链接可在仓库中解析；历史未导入代码用路径说明，不制造不存在的可点击链接。
- 公开文档不依赖个人绝对路径或私人任务链接；真实密钥、图片、PSD、会话和日志不进入提交。
- 当前实现与规划 API 区分；源代码迁移、测试通过、用户确认和 PR 合并分别记录。
