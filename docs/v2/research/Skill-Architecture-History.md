# COS 与 Photoshop 两种 Skill 职责

整理：2026-09-20，来自 2026-08／09 的已有方案和 LS Alpha 实现记录。本文为可在仓库阅读的摘要；私人任务标识、原始对话和本机路径保留在原始记录中。

既有方向一直区分两种职责：

- COS 领域 Skill：理解角色与修图目标、编辑／保持范围、参考用途、阶段、审美验收和返修。
- Photoshop 操作 Skill：观察文档与可用能力，组织图层、蒙版和动作，读回结果并恢复失败操作。

两者在同一个外部 Codex harness 中按需加载，不要求两个独立模型或 Agent。MCP／UXP 执行器负责真实动作；Skill 的文字约束不能替代事务、源文档绑定或精确蒙版。

现有 cos-effect-prompt V2 是 Nano Banana／Gemini 图像编辑提示词编译器，支持生成、反推、诊断和迭代；它有可复用的 COS 局部知识，尚未覆盖选片、样片、组图、返修和发布的完整生产组织。

2026-09-12 已在 LS 工作区接入 photoshop-use 的观察／定位指导和真实 PS MCP。此前 09-07 历史笔记中“未发现独立 Skill”的结论属于早期时间点，不再表示当前状态。

曾讨论的外部复用候选包括 [photoshop-mcp](https://github.com/alisaitteke/photoshop-mcp)、[editmamei](https://github.com/editmamei/editmamei)、[dcc-mcp-photoshop](https://github.com/dcc-mcp/dcc-mcp-photoshop)、[00bx photoshop-mcp](https://github.com/00bx/00bx-photoshop-mcp) 和 [DesignEcho-Agent](https://github.com/CHEN126110/DesignEcho-Agent)。本轮没有重新审计这些项目的当前功能、工具数量或许可证，不把它们视为已接入。

V2 的具体职责与实施边界以 [PRD](../PRD-LS-Studio.md)、[架构](../ARCHITECTURE.md) 与 [实施计划](../EXECUTION-PLAN.md) 为准。
