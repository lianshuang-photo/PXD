# 旧 PXD 复用与 GitHub 状态

核对日期：2026-09-20。固定基线：[main @ 3c9fc7d](https://github.com/lianshuang-photo/PXD/tree/3c9fc7d25f0b9691346b5fdc0197a6e99305c676)。这些是旧应用资产，不代表已移植到 LS。未运行旧应用的全部真机功能。

## main 中的复用候选

| 资产 | 固定版本来源 | 评估与迁移边界 |
|---|---|---|
| Gemini／Forge 引擎 | [generationEngine.ts](https://github.com/lianshuang-photo/PXD/blob/3c9fc7d25f0b9691346b5fdc0197a6e99305c676/src/services/generationEngine.ts)、[imageModelClient.ts](https://github.com/lianshuang-photo/PXD/blob/3c9fc7d25f0b9691346b5fdc0197a6e99305c676/src/services/imageModelClient.ts)、PR #27／#31／#34 | 已读接口与部分实现；可参考请求、错误和取消设计。依赖旧 AppSettings，需适配 Companion、Asset 和 Job，不能直接把旧 React 控制器搬进 LS。 |
| 任务池 | [generationTaskPool.ts](https://github.com/lianshuang-photo/PXD/blob/3c9fc7d25f0b9691346b5fdc0197a6e99305c676/src/services/generationTaskPool.ts)、PR #41 | 已读状态与内存记录结构。并发、取消、回贴串行的设计可复用；内存 Map 与函数闭包不能代替新任务的持久化恢复。 |
| 历史 | [generationHistory.ts](https://github.com/lianshuang-photo/PXD/blob/3c9fc7d25f0b9691346b5fdc0197a6e99305c676/src/services/generationHistory.ts)、PR #33 | 已读 entry 字段，保存 prompt／params／thumbnail 并依赖 UXP bridge。不能据此认定完整源图、refs、mask 和产物已经持久化。 |
| PS 执行与锁 | [photoshop.ts](https://github.com/lianshuang-photo/PXD/blob/3c9fc7d25f0b9691346b5fdc0197a6e99305c676/src/services/photoshop.ts)、[psLock.ts](https://github.com/lianshuang-photo/PXD/blob/3c9fc7d25f0b9691346b5fdc0197a6e99305c676/src/services/psLock.ts)、PR #28 | 拆出生产抓图、放置与 modal 相关可复用操作；对真实蒙版、文档身份和回滚重新验收，不能只依赖旧测试名称。 |
| 参考图、预设与参数 | `src/services/referenceImages.ts`、`presets.ts`、`promptParams.ts`；PR #32／#36／#37 | 复用 schema、解析和验证候选，接入新 Asset／CapabilityDraft；不保留双套参考状态。 |
| 镜头、分块、海报 | `src/services/cameraView.ts`、`tiledUpscale.ts`、`posterWizard.ts`；PR #38／#40／#39 | 已确认源码和测试存在；须在相应阶段评估算法和契约，重新验证 UXP UI 兼容与 Agent 接续。 |
| 工作区布局与引导 | `src/services/layoutExperience.ts`；PR #35 | 可参考用户体验；不覆盖当前已在 UXP 修好的面板布局。 |

上述相对源码路径均位于固定 main 基线。历史测试可作为回归案例的来源；移植后仍需对新运行环境验证。

## 尚未合并的旧 PR

| PR | 2026-09-20 状态 | 分支基线 | V2 处理方式 |
|---|---|---|---|
| [#42 AI colorization](https://github.com/lianshuang-photo/PXD/pull/42) | OPEN | main | B25 复用候选，保持原 PR 状态 |
| [#43 global partition](https://github.com/lianshuang-photo/PXD/pull/43) | OPEN | main | B15 复用候选 |
| [#46 multi-region atlas](https://github.com/lianshuang-photo/PXD/pull/46) | OPEN | main | B17 复用候选 |
| [#48 relight energy layers](https://github.com/lianshuang-photo/PXD/pull/48) | OPEN | codex/issue-12 | 先检查依赖 #44 的实际代码，不能当作独立可合并 PR |
| [#44 visual relighting](https://github.com/lianshuang-photo/PXD/pull/44) | CLOSED，未合并 | codex/issue-3 | B19／B20 的历史实现候选，不自动重开 |
| [#45 scene packs](https://github.com/lianshuang-photo/PXD/pull/45) | CLOSED，未合并 | codex/issue-3 | B23 的历史实现候选 |
| [#47 VFX](https://github.com/lianshuang-photo/PXD/pull/47) | CLOSED，未合并 | codex/issue-3 | B24 的历史实现候选 |
| [#49 recycle bin](https://github.com/lianshuang-photo/PXD/pull/49) | CLOSED，未合并 | codex/issue-9 | B12／B34 的历史实现候选 |

## 追踪口径

[旧 issue #25](https://github.com/lianshuang-photo/PXD/issues/25) 是 #1–#24 的历史交付记录。当前 #26–#41 共 16 个 PR 已合并；其正文中的部分“open”描述已过时。本次没有重写历史勾选、关闭 issue 或合并 PR。

V2 独立使用 Gxx 工作包和 Bxx 能力编号。移植必须在 PR 中记录原始文件／commit、采用部分、修改原因及新的验收证据；优先移植边界清楚的模块，不整批 cherry-pick 旧分支的 UI、全局状态和依赖链。

README 声称 MIT，但核对基线未找到独立 LICENSE 文件，GitHub licenseInfo 为空。源代码与第三方配方／字体的归属应在 G00 来源清单中区分；此次文档没有替任何来源重新声明许可证。
