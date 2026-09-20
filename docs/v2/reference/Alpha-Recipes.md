# Alpha 配方数据与 V2 迁移

整理：2026-09-20。本文记录已存在的数据和 HTTP 接口；当前正式 Agent 尚无 recipe tools。V2 将通过共享能力服务提供给专业页和 Agent，见 [PRD](../PRD-LS-Studio.md)。

## 数据

`companion/factory_presets/*.json` 中有 121 份 `_isFactory: true` 记录、13 个 category。常见字段为 id、title、content、category、subCategory、refImages。

content 常为 JSON 字符串，可调项使用顶层 `@param:<名称>` 数值与 `@param:<名称>_desc` 说明。不能假定每份配方都有统一 parameters 数组；V2 应经过解析／验证，生成完整 schema，并保存配方版本。

| 检索别名 | category |
|---|---|
| face | head |
| hair / neck / arms / hands / legs / feet | 同名 category |
| body | torso |
| clothes | clothing |
| prop | accessory |
| full | fullbody |
| bg | background |
| light | lighting |

轮椅人体剪影是部位导航，与自动分割不同。V2 可以把热区映射到部位与配方 schema，不能以 Alpha 没有热区为理由删除该玩法。

## 已有接口

- `GET /recipes?q=&region=&limit=8`：返回检索行；当前默认和最大 8，非全文列表。
- `GET /recipes/:id`：返回单条数据。
- `POST /recipes/:id/load`：装入执行词，返回 execution 与下一步提示；不自动生图／提亮。
- `POST /job/params`：修改已装入配方的参数值。
- `POST /plan`：Alpha 本地规则；未知意图拒绝，不能默认第一条配方。

尚未完成：Agent 的正式检索／装入工具、完整参数 UI、自定义配方 CRUD／版本、配方 refs 进入生产输入，以及人机共用的草稿。部分文本说明过去称 Agent 可以调用 HTTP，那是设想，不作为已注册工具证据。

## V2 约定

装入配方更新 CapabilityDraft，不自动执行。全参数与参考图用途进入任务快照；`@param=0` 等模块过滤语义要在迁移时验证，不能静默丢失。预设管理、人体导航、分类／分页和 Forge 参数包是不同资源／能力，分别建模。

不会为 121 条数据建立 121 个独立 Skill。领域知识、配方数据和工具能力分别维护，按照 [能力台账](../CAPABILITY-MATRIX.md) 的 B04–B07 交付。
