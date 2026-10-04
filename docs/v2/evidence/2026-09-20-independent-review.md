# Independent validation — 2026-09-20

本次使用新的独立审查任务、detached worktrees和隔离runtime。原开发任务的通过结论未作为本次结论。

**结论：真机门禁不通过；无合并、发布或成功computer-use状态。**

## 精确范围

公共#52–61的HEAD、依赖基准、CI与产物已重新核对；#59、#60、#61均为以#58为比较基准的并行feature。公共HEAD如下：

| PR | HEAD |
|---|---|
| #52 | 359d63b54fac1b279f466703bfe3ac5b7710ccc4 |
| #53 | 3245b75244f85999396f7a9002b3a4567603aad0 |
| #54 | b35e004f08e83c1e9eda3526ea90c183d721be6f |
| #55 | 8ed1cd08e591109283e0acd191581ae6980b6785 |
| #56 | bc466491e4b23a1fb0957d03388df9e6ff67d706 |
| #57 | ff1c2b0dc9452dfb5ab0befd9b858a4665bafc96 |
| #58 | 70d6707a117e0b9437faedd945c99348369b0b49 |
| #59 | f4f99ea4fba8a668f333a305dcc6c727d20719f9 |
| #60 | 52739f85602ef0f29943b3eebdbd3271b6749d9d |
| #61 | 73d022fe3ee9c671b1880ea1105369d2d03027e4 |

真机与本轮浏览器操作仅绑定私有组装`6121333dd4fe9f99a065c2d7e76920bcf88b1992`，不能冒充这些公共HEAD的宿主验收。该组装没有汇总PR。

## 独立缺陷与复测

1. **P1 来源校验**：`companion/agent-http.js:7–9,33–36,63–65`允许`Origin:null`与跨站fetch metadata，经预检后读取合成会话、注册执行器并得到hostToken；新Studio路由拒绝相同来源。`companion/server.js`的fallback `/job`另允许普通非本机Origin读写合成document上下文并返回ACAO=*。已用随机端口/临时数据复现，未对真实host执行攻击。缺陷继承自#52导入路由；#63修复的独立复测结果见下。
2. **P2 历史模型丢失**：#59 `capabilities/result-drafts.js:6–12`仅继承job.provider；取消后的迟到候选虽然持久化实际model，original派生仍缺model、candidate-reference报REFERENCE_LIMIT_UNKNOWN。公共#59与私有组装均复现。
3. **撤销真机阻断，尚未归因**：PS真实图层组合属性修改成功；点击撤销后原生Photoshop主线程SIGTRAP崩溃。桥接记录HOST_UNCERTAIN并保留receipt，无撤销result。CoreFoundation/AppKit栈不足以确认插件根因，未将可见性descriptor差异当作已证实根因，未重试或重启宿主。

模型修复draft PR#62 `4824e8e5577f5dda8f73f8bcfd80553d95a5bc28`（base#59）已独立离线通过：原始取消/迟到/两类派生复现、12组模型证据矩阵、215pass/0fail/1skip、70JS check、clean build、解包smoke；hosted CI及其下载产物也已独立核对。F2仅在此focused提交闭环，原#59未修改。没有#62新增真机证据。

HTTP修复draft PR#63 `51fb56ff3ba67b63732a09c99c8b929cbe00c612`（base#57 `ff1c2b0dc9452dfb5ab0befd9b858a4665bafc96`）已独立离线通过：两条原始漏洞复现、61项来源/原生例外/本机别名referrer/执行器限制/预检/拒绝无CORS矩阵、182pass/0fail/1skip、66JS check、clean build和解包smoke。Hosted CI及下载产物manifest/SHA256/ZIP/共享guard入包已核对，实际解包runtime再跑61项矩阵和fallback原复现亦通过。F1仅在此focused提交闭环；原公共HEAD未修改。原生例外验证使用HTTP fixture，未新增真实UXP连接证据；computer-use仍pending。

本地两修复组合 `8ab0e1af33510600b26215e34c0c5c272088635a` 的唯一冲突合并点另作只读检查：Studio保留provider-settings分支，来源校验在路由/CORS/设置读写前执行，预检仍先于CORS。该组合的全量测试由父任务执行，本独立任务未重新运行，不能混作独立全量结论；组合无汇总PR，无新增host证据。

## 自动化与产物

10个原公共精确HEAD各自在独立完整worktree跑全量均0fail，每套仅跳过launchd专项；计数重叠不可相加。私有组装240pass/0fail/1skip，另独立launchd专项1/1通过。10份公共HEAD CI产物已实际下载并验证manifest.commit、SHA256、ZIP和解包启动。

新增跨功能E2E覆盖33个MCP工具发现、HTTP/MCP共享、preset复制编辑/显式refs/归档恢复/导入导出、过期revision、unset参数、两候选、清Key后幂等重放、实际model继承、不可变历史、重启持久化与secret不出现在公开返回。图像服务使用真实adapter加mock fetch，PS仅mock capture，不能算真实生成或宿主通过。

## 实际操作证据边界

环境为macOS15.6.1/Node22.22.3/Photoshop26.0.0；UXP版本未在本轮独立读回。素材为专用384×256 RGB8合成图。

- 通过Chrome UI与真实PS/UXP桥接，完成无选区明确拒绝、显式整图捕获、真实图层选择、中文粘贴名称及60%不透明度修改，真实receipt与PS界面读回一致。
- 撤销发生上述崩溃；UI与实际Agent均正确报告未知结果，没有假成功。
- 实际UI→Codex回合使用studio_get_draft和studio_get_job两次只读工具，读回同一revision/参数/回贴冲突。未完成Agent反向修改与生成回贴闭环。
- 本轮浏览器完成工厂只读/用户副本编辑/归档恢复、无Key默认model持久化、100%/200%设置页查看。中文paste成功不能替代IME组合输入验收。
- 独立review插件在UDT可加载并建立host连接，但原生浮动面板内容未由CUA暴露；原生输入/Enter/200%/JSON picker未验证。
- 原生选区孔洞/羽化回贴、跨文档关闭重开、取消/迟到真实网络、真实图像provider、PNG/JPEG回贴、COS样片及结果A/B实际交互本轮未验证。

V03合成图有限通过；V04失败/未知；V06、V07、V10、V11仅部分证据；V01、V02、V05、V08真实条件、V09实际宿主重启、V12未验证。M0/M1/M2和原生面板门禁保持未通过。

主分支保护核对并保留，原Alpha快照180/180哈希匹配。测试runtime已停止，host已释放；独立插件登记与合成素材保留。崩溃后文档恢复状态需先由用户确认，未强制退出或自动重试。详细日志、完整本机报告及含环境路径的数据留在本地，没有发布无关私人截图。
