# 合并准备与下一轮开发 — 2026-09-21

状态：**用户已授权合并符合门禁的 PR；本轮尚无 PR 满足全部条件，未合并 main。** 本记录区分授权、源码修复、自动化、独立代码复核和实际宿主验收，不授予成功的 computer-use 状态。

## GitHub 门禁核对

本轮读取 main 保护和 #52–#67 的状态：严格要求 `ls-studio-tests`、`ls-studio/computer-use`、一个 GitHub approving review、最近一次 push 后的独立批准、过期批准失效和讨论解决；管理员同样受限。当前认证账号也是这些 PR 的作者，不能自行提供所需的独立 GitHub 批准。agent 的代码复核不替代它。

核对时上述 PR 均为 draft、没有 GitHub approving review。#52 的目标是 main；其余使用声明过的临时比较分支。#67 在比较分支上的 CLEAN 不代表可以合并 main，也不代表文档检查豁免 required status。前置 PR 真正落入 main 后，才重设依赖 PR 的目标并更新源码、检查、审批和适用验收。

main 仍为 `3c9fc7d25f0b9691346b5fdc0197a6e99305c676`。没有绕过保护、伪造批准或成功的宿主状态；Alpha tag、安装运行时和用户素材不属于本轮变更。

## 将修复纳入对应模块候选

以下是功能分支上的修复吸收，不是 GitHub merge。#54/#57/#59 使用带原提交说明的 cherry-pick；对应完整源码树与原修复头一致。独立复核、最新 CI 及未通过的宿主条件分别保留。

| 候选 | 本轮 source commit | 变更与本机验证 |
|---|---|---|
| #52 foundation | `4421e24ab541da3cfc0cb4de6696a1928f7501fa` | 前移 #63 中适用于 foundation 的旧 server、Agent 与 bridge HTTP 来源保护；共享 helper 与原修复同 blob，未带入 Studio 运行时。67 pass / 0 fail / 1 launchd skip；48 JavaScript/资源检查；干净构建/解包 smoke |
| #54 Photoshop | `1b247b9f4a48cad9ce0a5de40a3fd894f9d6242e` | 纳入 #65 的 visibility target 与仅恢复变化字段修复。121 pass / 0 fail / 1 launchd skip；54 JavaScript/资源检查；干净构建 |
| #57 runtime | `9422100b221376d11621d84780c6604987246774` | 纳入 #63 的完整共享 HTTP guard。guard/server 针对性 10/10 通过 |
| #59 result revisions | `46c14c09df221b382bef6e671afd270c968333da` | 纳入 #62 的迟到结果实际模型继承。result-drafts/capability-service 针对性 30/30 通过 |

#52 的回移由另一位 agent 独立检查最终 diff 和调用方，针对性 11/11 通过、无阻塞；#54/#57/#59 由未执行移植的 agent 核对完整源码树、父提交和二进制 diff 与原修复一致。它们是独立代码复核，均不是 GitHub approving review。

表内报告本机验证，不报告新 head 的 hosted CI 成功；新 SHA 的 checks 必须重新运行，以对应 PR 当前记录为准。更新分支会使旧 CI、审批和宿主状态不再代表当前候选。superseded 状态也以原修复 PR 的明确记录为准。既有 #62/#63/#65 的历史验证不被改写成新 head 的真机验收。表内 suite 相互重叠，不能相加。

## 前端修复组装与原生面板限制

新的私有组装 `72889fba2c477598ff4c4036f8094416621b81a8` 在 `f0a622b162229fb99cc48cd5d45a55f5a82f17d2` 上吸收 [#66](https://github.com/lianshuang-photo/PXD/pull/66) 的前端修复与 [#67](https://github.com/lianshuang-photo/PXD/pull/67) 的工程规范，没有 aggregate PR。CSS 接合保留结果比较规则并应用 provider 设置容器防收缩；独立 reviewer 核对增删内容与原修复一致，未发现新增阻塞。

该组装通过 **270 tests / 0 failures / 1 deliberate launchd skip**、80 JavaScript/资源检查、干净 release-mode ZIP 构建，以及实际解包后的来源校验和临时端口启动 smoke。没有运行付费生成，也没有替换已安装服务。它只是后续验收候选，不能给各模块 PR 继承成功状态。

实际 Photoshop 检查仍针对 #66 的源码 `b5a9bc1e7701f48767ce4479cbc381216a5b4249`，不是上述新组装。独立开发副本的 DEV-SOURCE 已记录该提交且 dirty 为 false；这与最早的未提交试验副本不同。本轮 UXP Developer Tools 已显示 LS Studio Frontend Review 为 Loaded，PS 的增效工具菜单也有该入口。computer use 展开并点击入口后仍只能稳定获取 PS 主文档窗口，未取得可操作的插件浮动面板。此前的 load timeout 记录保留，但当前 Loaded 也不能证明前端验收通过。

未通过项包括修复后的原生布局和控件、浅/深色、100%/200%、常规/窄面板、焦点、Enter/Shift+Enter/输入法、配置保存反馈，以及包含预设和结果比较的完整面板。没有为此重启带用户文档的 PS；隔离测试服务保持停止。真实供应商与 COS 样片验收也尚未完成。

## 下一步开发边界

代码评估确认，抓图/参考 → 共享草稿 → Agent 读改 → 候选 → 比较/回贴 → 派生草稿的基础调用链已经存在。无需重新实现 Agent、provider 或结果模块。

下一条有界开发任务是**修订来源追溯**：在现有 deriveDraft 上持久记录父任务、所选候选和派生方式，并随下一次运行固定到任务快照，UI 与 MCP 读取同一份记录。普通草稿更新不得伪造或覆盖来源，旧存储须兼容，派生本身不能触发生成或 PS 写入。这一工作不宣称新的前端或 G08 通过。

结构化反馈/认可候选、跨修订选择认可版本，以及路线图中的原生色光能力仍是后续边界。首先完成当前 PS 面板验收和真实供应商/样片的完整 M1 路径；G08、M0/M1 和 M2 均不因本轮合并准备而完成。
