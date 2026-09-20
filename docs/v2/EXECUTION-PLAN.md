# 用户确认后的实施与 subagent 分工

更新：2026-09-20。**用户已确认启动，并要求完整保留 Alpha、保护 main、严格 review＋computer use 真机验收后才能合并。** 当前进度见[实施状态](IMPLEMENTATION-STATUS.md)，GitHub 门禁见[协作规则](COLLABORATION.md)。以下按模块实施、分批组装、完整验收的顺序执行。

## 1. 工作包

路径前缀均为已导入的 `apps/ls-studio/`。以下保留工作包依赖与分工；实际完成范围、review 和验收见[实施状态](IMPLEMENTATION-STATUS.md)。G00–G07 首批代码已集成并拆为 #52–#58；G08 未通过。新增结果与设置功能、G09 中的 B05 预设管理已实现并独立 review，分别在 #59／#61／#60 待宿主验收。B06 和 G10–G21 未开始。

| 编号 | 任务 | 依赖 | 交付／验收 |
|---|---|---|---|
| G00 | 导入 LS Alpha 基线、来源清单、独立 package 作用域与运行说明 | 用户确认 | 哈希核对；旧根应用不变；隔离回归；明确当前 mock 边界 |
| G01 | 固定共享对象、状态、错误、schema 与模块接口 | G00 | 契约样例、接口 fixture、所有权表；UI/MCP 后续都用同一模型 |
| G02 | Asset／Job 持久化、幂等、恢复与草稿版本 | G01 | 原输入不变、重启可恢复、过期更新冲突、取消不自动重发 |
| G03 | PS 生产抓图、真实 mask、原生修改、回贴与回执 | G01 | 文档隔离、孔洞／羽化、事务错误、原层恢复、精确撤销 |
| G04 | 首个真实 BYOK 图像供应商适配 | G01 | 配置／能力、请求／解析／取消、结果资产、错误分类；真实运行条件单独记录 |
| G05 | 专业 UI 接入共享任务与候选 | G02/G03；生成路径另需 G04 | 参数／refs／设置真正生效；比较、回贴、取消／恢复 |
| G06 | Agent MCP 接入同一能力 | G02/G03；生成路径另需 G04 | 发现／读改草稿／运行／结果／取消／回贴／回滚，双向接续 |
| G07 | 配方完整 schema 与两种 Skill 指引 | G01，运行接线依赖 G02/G04 | 配方所有参数与 refs 进入任务；Skill 不宣称未实现工具 |
| G08 | 跨入口与真实样片验收 | G05–G07 | 完成 M1 场景和 V01–V12；缺 live 证据不标记完成 |
| G09 | 人体部位与预设管理 | 共享基础；阶段完成仍依赖 M1 | B05 已提前完成实现、待宿主验收；B06 未开始；部位导航与自动检测区分 |
| G10 | 2D／3D 灯光 | M1 | B19／B20；专用画布、共享灯具 spec 与真结果 |
| G11 | 半合成三模式 | M1 | B22；半合成／地台／垂悬分别验收 |
| G12 | VFX | M1 | B24；主辅参数、遮挡／受光与失败迭代 |
| G13 | 调色与本地色彩匹配 | M1 | B25／B26，扩充 B07 与角色配置 |
| G14 | 镜头与场景 | M2 共享工作区模式 | B21／B23 |
| G15 | 分区与分块 | M1；批量调度与 G17 协调 | B15／B16 |
| G16 | 多区拼接 | M1 | B17；跨源变换与分别回贴 |
| G17 | 批量、文生图候选与资源估算 | M1 | B09／B14／B33／B34 的生产扩展 |
| G18 | 示波器、海报和整组发布验收 | M2，批量使用 G17 | B27／B28；整组色彩／返修／输出 |
| G19 | 节点流程 | M3 | B18；graph 与同一任务服务 |
| G20 | Forge、ComfyUI | M1，完整交付 M4 | B29／B30；动态能力、参数与取消／恢复 |
| G21 | Actions、快捷入口与可选同步／扩展 | M3 | B31／B32／B34；不另建执行系统 |

B05 的提前实现复用已稳定的共享基础，不跳过 M1 验收，也不把 G09 标为整体完成。B06、G10 之后先按上表保留工作包，进入阶段时再细拆文件与案例，不为每个远期模块同时启动 agent。

## 2. 首批派发记录：先契约，再并行

主 agent 先单独完成 G00／G01，建立可运行基线，稳定 schema 和模块接口；用户确认启动不等于允许跳过此步骤。当前环境按“主 agent＋最多三个 worker”组织。

第一波：

| Worker | 独占范围 | 禁止顺手修改的共享文件 | 接口验证 |
|---|---|---|---|
| A：任务与资产（G02） | `companion/assets/**`、`companion/jobs/**`、对应 tests | `server.js`、`plugin/main-014.js`、MCP 注册 | 使用 G01 fixture 验证持久化、恢复、重复请求、草稿冲突 |
| B：PS 执行（G03） | `plugin/ps-capture-014.js`、`ps-return-014.js`、新增 `ps-edit-014.js`、`ps-agent-014.js` 及对应 tests | `plugin/index.html`、`main-014.js`、`server.js` | fake host 边界；真机由集成人串行安排 |
| C：图像供应商（G04） | `companion/providers/**`、对应 tests | 全局凭据、`server.js`、UI、任务状态机 | fixture 错误／取消／解析，随后真实供应商案例 |

主 agent 独占 `companion/domain/**`、capability handler 的集成、入口路由、manifest、启动脚本和文档。worker 发现契约不够时提出变更，不同时修改各自版本。

第二波在第一波接口可用后派发：

- G05 worker 独占 `plugin/main-014.js`、专业工作区／任务视图及其样式和测试，移除旧独立执行状态。
- G06 worker 独占 `companion/photoshop-tools.js`、`photoshop-mcp.cjs`、新增 HTTP 薄适配与对应测试；调用统一 handler，不复制执行逻辑。
- G07 worker 独占新配方模块、`companion/skills/**` 及配方测试；全局已安装 COS V2 先保留，项目级改动可审阅。
- 主 agent 负责 `server.js` 与 `plugin/index.html` 的最后接线及冲突处理。若 G03 尚在维护宿主模块，G06 不并行改其文件。

## 3. 每次派发必须包含

1. 一句话目标、所属 Gxx／Bxx、明确不承担的其他工作包。
2. 当前集成 commit、独占路径、依赖接口、允许使用的 fixture 与输出契约。
3. 明确告知“你不是唯一工作者；不要回退他人修改；遇到接口变化与集成人协调”。
4. 可验证的验收条件和失败路径，要求交回代码、测试结果、未验证边界与文档更新。
5. 源码复用位置与限制，避免重做已有适配器，也避免盲搬旧控制器。

当前同一任务树中的 subagent 共享目录，靠文件所有权避免冲突；不能假设 spawn 会自动创建隔离 checkout。若改用独立 Git worktree，主 agent 显式创建并给出绝对路径，只在集成分支接收已验证提交。

## 4. 验证与集成纪律

- worker 测试各自有意义的边界；主 agent 验证跨模块接线和恢复，不用大量重复的实现镜像测试替代真机证据。
- 每块由未实现该块的另一位 agent review。可轮换 A/B/C 的 review 对象；有效问题修复后复测，禁止自审即通过。
- 运行 Photoshop 写入、生产 Companion 切换和真实模型请求由主 agent 串行协调；worker 不各自抢占端口、重启同一服务或操作用户当前 PSD。
- 集成回归通过后开 PR，说明 before/after、来源、验证与限制。保留用户最终审阅，不自动合并。
- 真实供应商 endpoint／model／凭据和一组目标样片是 live 验收输入；如未提供，可继续独立实现与 fixture 验证，但 G08 不标记完成。

## 5. 当前收尾与后续派发

G00 导入和 G01 契约已完成，原 #50／#51 已关闭且没有合并；现在按[模块交付索引](MODULAR-DELIVERY.md)管理 #52–#58 和三个平行功能 draft PR。三个功能使用 #58 分支作临时比较基底，禁止向该分支合并；依赖进入 main 后 retarget／更新，再重新执行 review、CI 与对应提交的真机验收。

| 已派发功能 | 独立提交／PR | 交回状态 | 剩余验收 |
|---|---|---|---|
| 历史结果比较与修订草稿 | [#59](https://github.com/lianshuang-photo/PXD/pull/59) | 实现、内部交叉 review、CI 通过 | 原生 UXP 比较与完整 UI↔Agent 修订接续、真实结果 |
| B05 预设管理 | [#60](https://github.com/lianshuang-photo/PXD/pull/60) | 实现、内部交叉 review、CI 通过 | 原生 JSON picker／保存、参考映射与宿主工作流 |
| Provider／模型设置与默认值 | [#61](https://github.com/lianshuang-photo/PXD/pull/61) | 实现、内部交叉 review、CI 通过 | 原生表单、明确配置后的真实 provider 与样片 |

每个功能由单独 worktree 的 owner 修改，交叉 reviewer 只读审查，主 agent 负责共享入口移植和临时组装。私有组装 `6121333dd4fe9f99a065c2d7e76920bcf88b1992` 已通过独立审查、240 pass／0 fail／1 launchd skip、78 JS 检查、clean build 与解压 smoke；不为这个组装开整体 PR。合成素材的[浏览器操作证据](evidence/2026-09-20-feature-browser.md)已记录，不能转为各 PR 的宿主成功。

下一步由集成人串行安排精确提交的 Photoshop／UXP 验收，补齐原生文件操作、完整 Agent 接续和真实样片链路；内部 review 不能替代 GitHub 独立账号批准，所有 live status 保持 pending。B06、G10 之后的专用功能按阶段另行派发，不以这轮预设子项通过提前宣告 M1/M2 完成。
