# 修订来源交付与验收状态 — 2026-10-04

本轮继续执行“符合门禁的 PR 可以合并，随后开发下一步”。**没有合并 main；下一步功能已提交为 [PR #68](https://github.com/lianshuang-photo/PXD/pull/68)。** Alpha 与已安装服务未替换，没有执行真实供应商请求。

## 新功能与独立复核

#68 source 为 `3975d8b3073aeeea6f4d8abe4501eb5c28c2a531`，临时比较 base 为 #59 的 `46c14c09df221b382bef6e671afd270c968333da`。功能只扩展共享派生草稿与任务快照：记录父任务、候选及派生方式，普通创建/更新无法指定来源，编辑、冲突返回和重启后保留来源；原任务快照保持不可变。旧版无来源记录的数据可以读取，不给历史数据虚构来源。这里的兼容不意味着旧二进制能读取新增字段后的存储。

两位独立 reviewer 分别检查存储/契约与 capability/HTTP/MCP/UI 调用链。接口侧未发现阻塞，35 项针对性测试通过。存储侧发现内部 JavaScript 传入的非枚举自有属性可绕过普通 createDraft 的字段白名单；JSON HTTP/MCP 不能表达这一输入。最终提交显式拒绝普通创建的自有 lineage，并加入无存储写入的重现回归。原 reviewer 复核后没有剩余阻塞。

没有新增控件、CSS、反馈或认可候选界面；现有专业页和 Agent 共用相同对象与派生操作。生成和 PS 写入仍需后续显式执行。本轮实现不等于 G08/M1 完成，也不能替代独立 GitHub 批准。

## 验证范围

| 对象与 source | 实际结果 |
|---|---|
| 功能实现 `8e10db4122cfe51ee6ec4cf241af8b80c2adf16d` | 本轮完整 suite 223 pass / 0 fail / 1 deliberate launchd skip；70 JavaScript/资源检查、干净构建和解包来源/启动 smoke 通过 |
| 最终修复 `3975d8b3073aeeea6f4d8abe4501eb5c28c2a531` | 修复后 jobs-store/result-drafts 38/38 通过；最终源码重新构建和解包 smoke 通过；[hosted CI 37138851996](https://github.com/lianshuang-photo/PXD/actions/runs/37138851996) 成功 |
| 完整私有组装 `9d8c43eeb38d2fc50a89b43ec79f15bfe336cd63` | 279 pass / 0 fail / 1 deliberate launchd skip；80 JavaScript/资源检查、干净构建和解包 smoke 通过；无 aggregate PR |
| Browser / PS backend / native panel on #68 | 未验证；没有把自动化结果标为 computer-use 成功 |

组装在 `72889fba2c477598ff4c4036f8094416621b81a8` 上纳入 #68，保留已有参数清除的 `patchParams/unsetParams` 和重复请求核对的 `findJobByRequestId`，加入只读来源字段。独立 reviewer 检查三处组合，没有漏掉原功能。额外回归确认清除 model/temperature 默认参数时来源保留、旧任务快照不变、新快照继承来源。各 suite 重叠，不能将测试数相加或把组装证据转给不同模块头。

## 真机尝试与未完成项

本轮开始时 PS 和 UXP Developer Tools 均未运行。通过 computer use 启动两者；首次启动调用超时，随后读取到已运行的 PS 与 UDT。UDT 成功加载 LS Studio Frontend Review，并显示 Plugin Load Successful。开发副本的 DEV-SOURCE 仍为 #66 的 `b5a9bc1e7701f48767ce4479cbc381216a5b4249`、dirty=false；与 source 比对后，index.html 的差异仅是开发配置脚本，另保留既有开发 manifest/runtime 配置。这不是 #68 或新组装的宿主结果。

仅打开专用的 384×256 合成测试 PNG；没有操作用户照片或保存图像修改。通过 PS 增效工具菜单激活测试面板，并尝试切换窗口后，自动化仍只能取得主文档窗口，未获得可操作的插件浮窗。没有继续把初始化/加载成功当作原生视觉与输入验收，也没有重置用户工作区或扩大插件权限。

尚需：实际原生面板交互与样式验证、最终组装 UI/Agent 接续、真实供应商/样片路径、适用的 PS 回贴/恢复验证，以及各候选的独立 GitHub 审批。相关 computer-use 状态保持 pending。

## 合并状态复核

main 仍是 `3c9fc7d25f0b9691346b5fdc0197a6e99305c676`。保护仍要求严格的两项状态检查、独立 approving review、最近 push 后批准、旧批准失效、讨论解决，并对管理员生效。认证账号也是 PR 作者，无法自行满足 GitHub 的独立批准。

#62/#63/#65 已关闭为 superseded，修复分别进入 #59/#57/#54；它们不是 merged，源码与 review 记录保留。#52 的基础版 HTTP 修复也已推送。重新读取确认这些模块当前 source 的 hosted CI 已成功：[#52](https://github.com/lianshuang-photo/PXD/actions/runs/35527944466)、[#54](https://github.com/lianshuang-photo/PXD/actions/runs/35527876682)、[#57](https://github.com/lianshuang-photo/PXD/actions/runs/35527887259)、[#59](https://github.com/lianshuang-photo/PXD/actions/runs/35527928414)。独立 GitHub 审批和适用宿主验收仍未满足，因此没有绕过门禁合并，也没有合并进临时比较分支。
