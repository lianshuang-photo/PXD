# B05 自定义预设管理

实现范围：B05；以 `27fdfe1` 为开发基底。B06 的人体／17 部位导航不在本变更中，G09 整项仍未完成。既有 Alpha、工厂配方文件与用户 Photoshop 文档不受管理操作影响。

专业页的“管理我的预设”可以创建、复制工厂／用户预设、编辑完整参数定义、导入／导出 JSON、归档以及恢复历史版本。库里区分工厂与用户内容；工厂内容只读，复制后再编辑。未保存内容遇到切换或并发修改会保留，用户可以重新载入、另存或明确放弃新建内容。后台刷新保留已经展开的列表页和当前选中预设；改变搜索筛选才回到第一页。

预设库由 Companion 持久化，专业 UI 与 Agent 使用同一接口。每次修改有 revision，载入草稿核对所选 definition hash；历史恢复产生新 revision。已经创建的 Job 保留原 prompt、recipeId、sourceHash 和参数值，不会跟随库更新。

参考图在预设中表示为具名用途槽。创建／编辑可以增加、移除和指定用途；导出只携带这些槽，图片不在预设文件中。使用预设时，先在专业页导入参考图，再为每个槽显式选择资产，最后点击“载入配方到共享草稿”。Agent 也需提供同一顺序和用途的 managed refs。创建、装入、恢复均不自动发起生成或 PS 修改。

新增共享操作为 `createRecipe`、`copyRecipe`、`updateRecipe`、`importRecipe`、`exportRecipe`、`listRecipeVersions`、`archiveRecipe`、`restoreRecipe`，对应 MCP 的 `studio_create_recipe`、`studio_copy_recipe`、`studio_update_recipe`、`studio_import_recipe`、`studio_export_recipe`、`studio_list_recipe_versions`、`studio_archive_recipe`、`studio_restore_recipe`。现有 `listRecipes` 增加来源／归档筛选，`getRecipe` 可指定历史 revision，`loadRecipe` 增加 `expectedSourceHash`。详细契约与存储限制见 [模块说明](../../apps/ls-studio/companion/presets/README.md)。

验证包括真实本地 HTTP/MCP、资产／任务／预设 store 和 UI controller 接续，所有图像供应商与 PS 执行仍使用专用 fixture。浏览器／UXP 文件适配和 mounted 管理控件有自动化覆盖。此实现不代表 M0/M1 或 G08 已通过；合并前仍须独立 review，以及对应提交的真实 UXP 管理、JSON 文件选择／保存和参考映射验收。缺失现场验证时保持未验证，不能把测试替身写为 live 通过。
