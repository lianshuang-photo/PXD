# 共享结果审阅

本次在 #68 修订来源能力上增加 Companion 后端的共享审阅状态，供 UI HTTP 与 Agent MCP 使用。影响面为 `companion/domain/`、`jobs/`、`capabilities/service.js`、HTTP/MCP 适配及其契约测试；不改根 PXD 应用或 Photoshop 执行器。本 PR 不新增插件／浏览器 UI 控件、样式、布局或交互；界面接入另行交付。

实现所有权：存储与领域 worker 负责 schema、原子持久化、revision、请求去重和祖先读取；服务／传输 worker 负责同一能力的暴露、HTTP/MCP 输入与来源边界、跨入口测试及本文。集成人负责独立 review、组装和后续实际宿主验收。

审阅记录与生成、回贴和验收是独立事实。本次没有新 UI 验收，不代表 M1 或 `ls-studio/computer-use` 已通过。

## 用户路径与共享状态

读取候选实际像素 → 保存该候选的反馈 → 用户明确选择采用或取消采用 → 另一入口读取同一 review。反馈与采用是两种写操作：Agent 的视觉分析保存为反馈，不能顺带写成用户已认可。`recordedVia:ui|agent|system` 仅记录入口，不证明真人身份、审批或审美认可。采用记录不授权生成、自动回贴或 Photoshop 修改。

审阅保存在 `job.review`，不会修改不可变的 `job.snapshot`、`results[]` 或 lineage，也不改变生成与 placement 状态。任务取消后保留的迟到候选仍可评价、选择和取消选择；这些动作不恢复任务或增加回贴资格。反馈不会自动编译到提示词，也不改配方、预设或当前草稿。后续返修复用已有 `deriveDraft`，明确编辑并运行新草稿。

## API

HTTP 使用已有的 `POST /studio/call`、`X-PXDLS-Agent:1` 和本地访问边界；Agent MCP 通过现有带工具 token 的 `/studio/mcp` 调用同一服务。

| HTTP operation | MCP tool | arguments |
|---|---|---|
| `getJobReview` | `studio_get_job_review` | `{jobId}` |
| `updateResultFeedback` | `studio_update_result_feedback` | `{jobId,resultId,expectedReviewRevision,requestId,feedback}` |
| `setAcceptedResult` | `studio_set_accepted_result` | `{jobId,resultId,expectedReviewRevision,requestId}` |

示例：保存区域反馈，不采用候选。

```json
{
  "operation": "updateResultFeedback",
  "arguments": {
    "jobId": "job-example",
    "resultId": "result-example",
    "expectedReviewRevision": 0,
    "requestId": "review-example-1",
    "feedback": {
      "items": [{
        "area": "左侧发丝边缘",
        "category": "artifact",
        "description": "边缘存在光晕",
        "requestedChange": "减弱光晕，保留细发丝"
      }],
      "preserve": ["保留当前肤色"]
    }
  }
}
```

`feedback` 对象必须同时提供 items、preserve；完整替换该候选的当前反馈，其他候选与采用决定保持不变。`feedback:null` 明确删除该候选的反馈。items 最多 20 项，category 枚举为 `identity|composition|lighting|color|detail|artifact|scope|style|other`，description 必填且为 1–2000 字符；area 可选且为 1–120 字符，requestedChange 可选且为 1–2000 字符。preserve 最多 20 个 1–500 字符字符串。允许空数组；规范化后的 UTF-8 JSON 最多 64 KiB。区域仅为短文本，不引入标注坐标或蒙版。

采用操作要求 resultId 为本任务已有候选或 null；null 表示明确取消采用。传入另一任务候选会拒绝。两种写操作均拒绝客户端自填 recordedVia、批准字段和未知字段；适配层强制 source 为 ui/agent。工具文本只规定调用要求，服务端不会声称已经认证真人认可。

读操作返回 `{jobId,review,previousAccepted}`。未写过时 review 为 `{revision:0,feedback:[],acceptance:null}`，不会因此写盘；既有 getJob/listJobs 仅返回已经存储的可选 job.review。写结果为 `{jobId,review,appliedRevision,duplicate}`。持久化 review 的形状如下：

```js
{
  revision: 2,
  feedback: [{ resultId, items, preserve, recordedVia, updatedAt }],
  acceptance: { resultId, recordedVia, updatedAt }, // 初始为 null；取消采用后 resultId 为 null
  updatedAt
}
```

后续改反馈不更改采用记录的来源。新派生任务不继承父任务的 review。`previousAccepted` 沿不可变 `snapshot.lineage.sourceJobId` 查找最近仍有非空采用结果的祖先，返回 `{jobId,resultId,reviewRevision,recordedVia,updatedAt}` 或 null；遇到已清除的记录继续向上读取。revision 是祖先当前审阅版本，时间和来源取该采用记录。当前任务的采用与祖先记录相互独立；读取此前版本不自动恢复或回贴像素。

## 冲突、重试与持久化

expectedReviewRevision 必须是非负安全整数；未写过时用 0，第一次成功写入变为 1。审阅 revision 独立于草稿 revision 和任务执行状态。每个新写入意图使用一个稳定 requestId；请求去重与 review 在同一原子事务持久化。

去重在当前 revision 检查之前进行，指纹包含操作、任务、原 expectedReviewRevision 和规范化内容，不包含 source。HTTP 与 MCP 因而可以核对同一次请求，不改写最初入口。相同请求重试返回当前 review、原 appliedRevision 和 duplicate:true；即使后来已有另一项修改，也不重做旧写入。相同 ID 的不同内容返回 REQUEST_CONFLICT。内部指纹不出现在公开返回中。

存储沿用 jobs/state.json 的校验和、原子 rename、目录确认、64 MiB 总限制和失败关闭规则。本次使用 schemaVersion 1 可选字段；旧记录可读，不猜测补写审阅；旧程序不能保证读取新增记录。反馈/采用 ID 归属和请求记录在存储边界独立校验。服务写入会在异步等待前复制请求，避免调用方后来改参数改变实际意图。

| 公共错误 | 调用方处理 |
|---|---|
| `INVALID_INPUT` | 修正字段、类型、长度、类别、体积或 revision；请求未受理 |
| `JOB_NOT_FOUND` / `RESULT_NOT_FOUND` | 重新读取准确任务及其候选，不能借用其他任务的结果 |
| `CAPABILITY_CONFLICT` | 审阅仅支持 image.edit 的结果，原生图层任务不支持 |
| `REVIEW_REVISION_CONFLICT` / 409 | details 为 `{jobId,current}`；保留本地意见、读取并协调当前审阅，再提交新意图；不是草稿冲突 |
| `REQUEST_CONFLICT` / 409 | 同 ID 已用于另一内容，先核对原请求；不自动生成新 ID 重试 |
| `STATE_CONFLICT` / 409 | 审阅 revision 已到安全整数上限，拒绝继续递增，不静默重置版本 |
| `STORAGE_UNAVAILABLE`（审阅写入）/ `TRANSPORT_UNCERTAIN` | 保存尚未确认，可能已经写入；先读回并用原 requestId、原参数核对，不用新 revision 自动重写 |
| `STORAGE_CORRUPT` / `STORAGE_FULL` | 检查任务存储；不覆盖、清空或回放生成/宿主请求 |
| `TRANSPORT_UNAVAILABLE`（MCP 审阅读取）/ `TRANSPORT_PROTOCOL_ERROR` | 未成功读取有效审阅，检查连接后重新读取；不提示用户重发写入 |
| `SERVICE_CLOSING` | 服务正在关闭，当前写操作未开始；恢复连接后读回状态 |

MCP 写入遇到网络中断、无法解析响应、缺失确认值或不匹配的确认结果时，不自行重试；返回保存未确认。确认校验包含任务 ID、完整审阅形状、正整数版本、appliedRevision 与原 expectedReviewRevision 的关系、duplicate 类型，以及尚未被后续版本改变的反馈／采用内容。合法跨入口重试可以保留首次 recordedVia，并返回更高的当前 review revision。持久化确认失败同样不能报成明确未写入。读失败与写入未确认分别描述，不泄漏底层异常。

## 验证范围

存储针对性入口为 `node --test tests/result-review-store.test.cjs`。服务／传输本次实际运行 `node --test tests/result-review-transports.test.cjs tests/studio-mcp.test.cjs tests/studio-http.test.cjs`，23/23 通过（命令均在 apps/ls-studio 中运行）。这些结果针对实现工作树；最终提交的统一检查与源码绑定由集成记录给出。服务／传输测试使用真实资产与任务 store、临时目录、临时 loopback HTTP/MCP，以及禁止调用的模拟 provider/host；候选为专用小图 fixture。

重点覆盖 revision 0 首写、跨入口反馈/采用读回、来源强制、冲突 current、64 KiB 和字段边界、外来候选拒绝、晚到候选评价、采用/清除、祖先读取、后续修改后重试、响应丢失后重启核对、保存确认失败和请求参数隔离。核对 snapshot、results、lineage、生成/placement 状态不变，并要求 provider/host 调用数为 0。

浏览器交互、真实 Photoshop 后端和原生面板交互均未在本 PR 验收。未新增 UI 控件，所以本轮没有新控件的主题、缩放和布局检查；后续 UI PR 必须完成这些检查。独立 review、最终 head CI 和既有合并/宿主门禁仍由集成人记录，不能把这里的 fixture 当作 M1 完成证据。
