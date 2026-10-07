# 企业报表平台（report-platform）项目约定

## 本地跑起来的正确姿势

```bash
cd /Users/skygreen/Downloads/my/report/report-platform

# dev（端口 3111）—— 必须 env -u NODE_OPTIONS，否则 fs shim 限流会让 .next 编译失败、全站 500
env -u NODE_OPTIONS /Users/skygreen/.workbuddy/binaries/node/versions/22.12.0/bin/node \
  node_modules/next/dist/bin/next dev -p 3111

# 类型检查（不要用 npx tsc）
/Users/skygreen/.workbuddy/binaries/node/versions/22.12.0/bin/node node_modules/typescript/bin/tsc --noEmit

# 脚本/测试（.bin/tsx 软链不存在，直接跑 dist）
env -u NODE_OPTIONS /Users/skygreen/.workbuddy/binaries/node/versions/22.12.0/bin/node \
  node_modules/tsx/dist/cli.mjs test/gateway.test.ts          # 网关对抗 20 例
env -u NODE_OPTIONS ... node_modules/tsx/dist/cli.mjs scripts/verify.ts          # live DB 8 例
env -u NODE_OPTIONS ... node_modules/tsx/dist/cli.mjs scripts/verify-lifecycle.ts # 生命周期 38 例
bash scripts/smoke-http.sh                                     # Web E2E 15 例
```

## 代码约定

- **API 动作路径是斜杠式，不是冒号式**：`/reports/{id}/delete`、`/reports/{id}/restore`、`/applications/{id}/disable`、`/applications/{id}/enable`。注释里别再写 `:action`，前端也别这么调 —— 冒号式会 404，且前端 `r.json()` 会把错误吞掉变成「点了没反应」。
- Next 15 App Router：`params` 是 Promise，路由里必须 `await params`，别写 `params.id`。
- 前端 fetch 一律「先判 `r.ok`、再 `r.json().catch(()=>({}))`、外层 try/catch」，保证失败一定有提示。
- zod schema 的可选字符串字段用 `.nullish()`（前端会传 null），下游再 `?? undefined` 收口。
- 平台库连接池挂 `globalThis`（dev 热重载会重建模块 → 连接打满 151）。
- MySQL：root/root；平台库 `report_platform`；业务演示库 `biz_demo`，只读账号 `report_ro`。

## 业务约束

- 数据源按应用隔离：A 应用的数据源只能给 A 用，跨应用绑定 403。
- 保存/改 SQL 前必须过 `validateOnly`（Parse→Validate，不执行）。
- 报表双轨：保存时同时给 CLIENT / DEVELOPER 各建一条 placement；单侧删除只影响该侧。

## 数据源删除 + 去重 + 改派合并（2026-10-07）

- **创建去重**：`createDataSource` 插入前查同应用 `(host,port,database_name,username)` 完全相同则抛 409 `DATA_SOURCE_DUPLICATE`（根治重复建源）。按连接元组判重（不是 name），两个不同只读账号连同一库仍允许。
- **删除**：`DELETE /api/data-sources/{id}`（仅 DEVELOPER）→ `deleteDataSource(ctx, id, targetDsId?)`。
  - 被 `report`/`run_record` 引用且无 `targetDsId` → 409 `DATA_SOURCE_IN_USE`（不直接删，避免悬空）。
  - 带 `targetDsId`（同应用、存在、非自身、ACTIVE）→ 用 `platformTx` 同事务把 `report`+`run_record` 的 `data_source_id` 改派过去再删源（**合并重复**标准做法），返回 `reassignedCount`。
  - 删的是默认源 → 自动回落到该应用下一个最早创建的 ACTIVE 源；释放连接池缓存 + `invalidateAppCache`。
- 前端：开发者页数据源行「删除」按钮；遇 409 弹出「改派并删除」卡片（下拉选其他同源源 → DELETE 带 body `{targetDsId}`）。

## ⚠ live 库 schema 与 schema.sql 不同步的坑

- 实时库 `sql_version` 表 **没有 `data_source_id` 列**（schema.sql 里虽写了，但 live 没执行这条 ADD）。依赖检查里别查 `sql_version.data_source_id`，否则报 `Unknown column`。
- 真正绑定数据源的是 `report.data_source_id` 和 `run_record.data_source_id`，删数据源的依赖校验只查这两张即可。

## 模型配置按角色作用域隔离（llm_provider.scope，2026-10-07）

- 需求：甲方也要能配模型，且**与开发者各是各的**（完全独立）。
- `llm_provider` 加列 `scope ENUM('DEVELOPER','CLIENT') NOT NULL DEFAULT 'DEVELOPER'`（live 已 ALTER；存量 2 条保持 DEVELOPER）。
- `listProviders(appId, scope, onlyActive)` 按 `scope=角色` 过滤；`createProvider` 写入 `scope=ctx.role`（谁建归谁）；`updateProvider/deleteProvider/setDefaultProvider/getProviderRow` 全部按 `scope=ctx.role` 校验（跨作用域 404，开发者删不到甲方的、反之亦然）。
- `setDefaultProvider` 只清「同 scope」的 `is_default` —— 开发者默认与甲方默认互不干扰。
- `resolveProvider(ctx, providerId)` 生成 SQL 时按 `scope=ctx.role` 过滤：甲方生成用甲方模型、开发者用开发者模型。未配置时文案按角色提示（甲方提示去「模型配置」自己加）。
- API 路由（POST/PUT/DELETE/`[id]/default`/`[id]/test`）**去掉了硬 `DEVELOPER` 403**，改由 service 的 scope 校验接管 → 甲方可 CRUD/测试/设默认自己的模型。
- 前端：开发者页 `d/page.tsx` 与甲方页 `c/page.tsx` 都加了「模型配置」tab（镜像：列表/添加厂商预设/填 key/本地模型/测试连接/设默认/启停/删除），下拉 15 厂商预设双方都能用（各自填各自 key）。甲方 `bootstrap.llmProviders` 精简视图补了 `is_default`/`status` 供 tab 显示。
- 验证：甲方建模型开发者列表看不到、跨作用域删除 404、自删 200、默认按 scope 独立；tsc 0、网关 20/20。

## 去除硬编码 deepseek key + 无模型时把需求交给开发者（2026-10-07）

- **去 key**：`.env.local` 删除 `LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL` 三行；`llm.ts` 的 `resolveProvider` 删掉 `process.env.LLM_*` 回落，**本角色无模型时返回 `null`**（不再复用任何硬编码 key）。开发者自己的模型仍在 `llm_provider` 表里（用户 UI 配置、AES 加密），不在代码中。
- **客户端无模型 → 自动存需求**：`generateSql` 在无 provider 时返回 `noModel:true`（区分「没配模型」vs「模型存在但生成失败」）。`c/page.tsx` 的 `gen()` 收到 `noModel` 时自动 `POST /requirements` 把描述提交给开发者并提示；gen tab 在无 `providers` 时显示说明；`help()` 仍用于生成失败后的补充求助。
- **开发者据此生成 SQL**：`d/page.tsx` 需求收件箱每项加「据此生成 SQL」→ 内联生成器（需求描述/数据源/开发者模型/生成/预览/保存为报表并通知甲方）。`requirement.ts` 新增 `fulfillRequirement(ctx,id,reportId)`（标记 `PENDING_CONFIRM` 并回填 `report_id`）；`requirements/[id]/route.ts` POST 开发者分支支持 `{reportId}` 一键完成。保存后报表共享、甲方端立即可见。
- 验证：客户端无模型生成返回 `noModel:true`；模拟前端提交需求→开发者收件箱可见→建报表→fulfill 置 `PENDING_CONFIRM`+回填 `report_id`→甲方 `bootstrap.reports` 可见；跨角色模型隔离仍成立（甲方 0 / 开发者 2）；tsc 0、网关 20/20。

