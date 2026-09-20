# 文档权威与同步

更新：2026-09-20。

## 主来源

PXD 仓库的 `docs/v2/` 是规划与实施状态的主来源。规划 #50 和原集成 #51 已关闭并被替代，未合并；当前按 [#52–#58 模块及 #59–#61 功能 PR](MODULAR-DELIVERY.md)交付。三个平行功能以 #58 作临时比较基底，不能向它合并；依赖落 main 后 retarget／更新并重新取得审批、检查和宿主证据。

用户确认、实现完成、内部 agent 交叉 review、GitHub 独立账号 approve、CI 通过、浏览器验证、Photoshop／UXP 验收和 main 合并是不同状态。每份记录必须绑定具体 commit 和环境，不能沿用历史状态替代新 head 的门禁。当前所有 live status 均为 pending，B05 实现完成不等于 G09 或 M1/M2 通过。

| 内容 | 主文档 | 修改要求 |
|---|---|---|
| 仓库／目录与迁移 | WORKSPACE-DECISION.md | 记录实际已做与计划动作，避免假装已迁移 |
| 产品范围和用户行为 | PRD-LS-Studio.md | 能力台账同步；不以技术阶段删范围 |
| B01–B36 的状态 | CAPABILITY-MATRIX.md | 状态改变附 PR／commit 和验收证据 |
| 阶段顺序和依赖 | ROADMAP.md | 实施计划同步，标注未启动或未验证 |
| 数据／接口与执行边界 | ARCHITECTURE.md | 新接口由主 agent 统一，worker 不复制另一套 |
| 任务拆分与文件所有权 | EXECUTION-PLAN.md | 每次派发更新依赖和所有者，不自动启动远期模块 |
| 模块／功能 PR 与当前实施 | MODULAR-DELIVERY.md、IMPLEMENTATION-STATUS.md | 记录准确 PR head、临时比较基底、CI 观察范围、内部审查与独立账号批准的区别 |
| 已有代码来源 | LEGACY-REUSE.md | 基线使用固定 commit；合并状态按 GitHub 核对日期 |
| 测试和真实结果 | VALIDATION.md、evidence/ | 历史宿主、本轮浏览器、合成 fixture 与未验证项分开；测试计数标明 pass/fail/skip，不累加重叠套件 |

## Alpha 目录同步方式

迁移前曾把同一套 `docs/v2/` 镜像到 Alpha 的 `docs/v2/`。G00 已导入源码，现按用户要求完整保留旧 Alpha，停止继续改写该镜像；当前文档只在 GitHub 的实施分支推进。

Alpha 原 `docs/PRD-LS-Studio.md` 改为指向新 PRD 的入口，README 更新范围和当前运行事实，旧 `companion/ide.md`／`recipes.md` 改为明确的 Alpha 接口记录。原 PRD／README／接口文件保留在本机带日期的归档目录，不能再次被误当成 V2 限制。

原研究与验证记录保留原日期和证据，顶部补上新文档入口。公开版研究移除个人绝对路径、私人任务标识与完整运行日志，只保留来源标识与公共材料；原始本机证据不删除。

`apps/ls-studio/README.md` 已链接根 `docs/v2/`，不再次复制整个规划树到应用里。Downloads 是来源快照；正式工作区与保留标签见 [COLLABORATION.md](COLLABORATION.md)。

## 分支与证据同步

本轮文档提交位于 #58 的 professional-ui 树，树中尚无三项功能新增文档。B05、结果修订与 Provider 设置的实现说明通过 [#60](https://github.com/lianshuang-photo/PXD/pull/60)、[#59](https://github.com/lianshuang-photo/PXD/pull/59)、[#61](https://github.com/lianshuang-photo/PXD/pull/61) 阅读；在文件进入当前树之前，不添加不存在的相对链接。

私有临时组装 `6121333dd4fe9f99a065c2d7e76920bcf88b1992` 的[浏览器记录](evidence/2026-09-20-feature-browser.md)只说明隔离环境中被实际操作的功能，不作为任一公开 PR head 的宿主成功记录，不创建整体集成 PR。33 个 MCP 工具、240 pass／0 fail／1 skip 和 78 JS 检查均描述该组装；#58 基础的 24 个工具、历史 193 项回归和各功能独立套件仍分别记账。

浏览器证据只发布步骤、合成素材说明与观察结果，不提交含其他标签页的原始截图，不附私人本机路径、个体任务／资产 ID 或用户资料。后续原生 UXP picker、完整 Agent 接续、真实 provider／COS 样片需要单独的精确提交验收记录。

## 同步检查

- B01–B36 全部且仅出现一次主表记录；每条有当前状态、交付阶段和验收依据。
- README／PRD／路线图／接口历史不再把 Forge、ComfyUI、人体、批量等写成 V2 永久排除项。
- 所有本地 Markdown 链接可在仓库中解析；历史未导入代码用路径说明，不制造不存在的可点击链接。
- 公开文档不依赖个人绝对路径或私人任务链接；真实密钥、图片、PSD、会话和日志不进入提交。
- 当前实现与规划 API 区分；源代码迁移、测试通过、用户确认和 PR 合并分别记录。
