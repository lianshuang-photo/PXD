# Alpha 0.1.5 专业页接口记录

整理：2026-09-20。本文描述迁移前的旧接口，**不是 V2 共用任务契约**。完整目标见 [PRD](../PRD-LS-Studio.md)，新契约见 [架构](../ARCHITECTURE.md)。

旧专业页有指令、参数、上下文和资料区，服务为本机 Companion。配方来源是镜像的 `companion/factory_presets/*.json`，只使用 `_isFactory: true` 数据。

| 操作 | Alpha 接口 | 实际边界 |
|---|---|---|
| 当前作业 | `GET /job`、`POST /job` | 服务端全局 lastJob；不是可持久化多任务系统 |
| 装入配方 | `POST /recipes/:id/load` | 写执行词，不运行 PS／模型 |
| 参数 | `POST /job/params` | 解析 content 顶层 `@param:*` 和说明；当前 UI 只呈现前三项 |
| 上下文 | `POST /job/context` | 主要同步元信息／参考芯片，与 Agent 附件分离 |
| 资料 | `GET /recipes?q=&region=&limit=8` | 当前上限 8；这是 Alpha 搜索限制，不阻止 V2 分类／分页 |
| 规划与编译 | `POST /plan`、`POST /compile` | 本地关键词规则；旧规则拒绝文生图；不是 Codex 编排 |
| 编辑 | `POST /apply` | 恒返回 mock，不能作为真实生图或修图证据 |
| 旧原子路由 | `/atom/brighten` 等 | 多数返回执行指示，由 UI 操作 PS；包成 MCP 不会自动获得执行回执 |

`GET /job` 的数据主要包含 instruction（recipeId/title/executionText）、params、context（document/selection/refs）和 loaded。旧专业页另有闭包 lastCapture／lastResultLayerId／attachedRefs；必须在 V2 迁到统一 Asset／Draft／Job。

旧配方数与按钮数不代表真实能力数。参数 JSON 可以保留按需查看，用户日常操作使用清楚的标签和视觉控件。

V2 保留人体剪影、完整参数、Forge／ComfyUI、批量和节点等目标。旧 Alpha 当时不提供这些界面或后端，是实现边界，不能当成后续禁止项。
