# 02 · Design（技术设计）

> **约束**：本轮不绑定具体技术栈（见 `00-prompt.md` 用户决策）。下文以**分层架构 + 领域模型 + 接口契约**描述，可用任意 HTTP 框架实现（Next.js / Express / NestJS / Spring Boot 均可）。
> **数据源范围**：一期仅 MySQL，通过 `DataSourceAdapter` 接口预留多源。
> **追溯**：本文件每个设计元素均对应 `01-requirements.md` 中的 REQ-\*。

---

## 1. 设计原则

| # | 原则 | 说明 | 关联需求 |
|---|---|---|---|
| DP-1 | **生命周期双轨制** | 报表的可见性不是单一字段，而是「甲方轨 × 开发者轨」两条独立状态机。这是整个数据模型的地基。 | REQ-LIFE-01~16 |
| DP-2 | **角色即上下文** | 无登录 ⇒ 角色只能由入口路径推导，服务端必须在每一次请求重算，不可信任前端传入。 | REQ-ACC-04/05/06 |
| DP-3 | **危险动作前移** | 一切 SQL 在执行前必须经过「解析 → 白名单校验 → 改写注入」三步，执行器只接受已被改写的安全语句。 | REQ-SEC-01~04 |
| DP-4 | **零信任前端** | 甲方的隐藏能力（SQL 文本、数据源）必须在接口层鉴权，不能只靠前端不渲染。 | REQ-META-04 |
| DP-5 | **默认临时** | 80% 是临时导出 ⇒ 主路径不产生报表实体；保存是显式分叉，不是默认行为。 | REQ-EXP-01 |
| DP-6 | **一切留痕** | 需求、SQL、执行、导出全部追加式写入，历史不可变。 | REQ-META-05, REQ-SEC-06 |
| DP-7 | **删除不可逆分层** | 甲方清空是「视图层消失」，开发者清空才是「实体消失」，中间用宽限期兜底。 | REQ-LIFE-06/10/15 |

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│  L0 接入层  Access Gateway                                         │
│  · 域名 + 目录前缀 → Application 解析                              │
│  · 角色推导（/c/ → CLIENT，/d/ → DEVELOPER）                       │
│  · 匿名 clientKey 下发（Cookie，非身份凭证）                        │
│  · [可选] 网关层 SSO / IP 白名单 / 限流                            │
└───────────────┬──────────────────────────────────────────────────┘
                │ RoleContext { appId, role, clientKey }
┌───────────────▼──────────────────────────────────────────────────┐
│  L1 应用服务层  Application Services（领域逻辑，无框架依赖）         │
│  ┌────────────┬────────────┬────────────┬────────────────────┐   │
│  │ ReportSvc  │ TagTreeSvc │ Lifecycle  │ RequirementSvc     │   │
│  │            │            │ Service    │                    │   │
│  ├────────────┼────────────┼────────────┼────────────────────┤   │
│  │ Generation │ ExportSvc  │ DataSource │ AuditSvc           │   │
│  │ Service    │            │ Service    │                    │   │
│  ├────────────┼────────────┼────────────┼────────────────────┤   │
│  │ Application│            │            │                    │   │
│  │ Svc        │            │            │                    │   │
│  └────────────┴────────────┴────────────┴────────────────────┘   │
└───────┬──────────────────────────────────┬───────────────────────┘
        │                                  │
┌───────▼──────────────────────┐  ┌────────▼──────────────────────┐
│  L2 SQL 网关  SQL Gateway     │  │  L3 元数据存储  Platform DB   │
│  ① Parser   语法解析          │  │  · application / data_source  │
│  ② Validator 安全规则校验     │  │  · report / tag_node /        │
│  ③ Rewriter LIMIT/超时注入    │  │    report_placement           │
│  ④ Executor 只读事务执行      │  │  · requirement / sql_version  │
│  ⑤ Shaper   脱敏与结果整形    │  │  · run_record / audit_log     │
└───────┬──────────────────────┘  └───────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────────┐
│  L4 数据源适配层  DataSourceAdapter（接口化）                      │
│  · MySQLAdapter（一期）                                            │
│  · ConnectionPool（按 dataSourceId 隔离，只读账号）                 │
│  · CatalogProvider（库/表/字段/注释元数据抓取与缓存）               │
└──────────────────────────────────────────────────────────────────┘

外部依赖：
  · LLM Service（仅接收：元数据 + 提示词，不接收业务数据）
  · Object Storage / 本地临时目录（导出文件，TTL 24h）
```

### 2.1 层间契约要点

- **L0 → L1**：传递不可变 `RoleContext`；L1 任何方法首参均为 `RoleContext`，禁止从请求体读取角色。
- **L1 → L2**：`SqlGateway.execute(ExecutionRequest)` 只接受结构化请求，**不接受裸 SQL 字符串绕过校验**。
- **L2 → L4**：所有连接从池中取只读连接；`SET SESSION TRANSACTION READ ONLY` 在取连接时执行一次。
- **L1 → L3**：平台元数据库与业务库**物理隔离**，元数据库账号与业务只读账号不复用。

---

## 3. 领域模型

### 3.1 实体关系

```
Application 1───n DataSource
Application 1───n Report
Application 1───n TagNode            （每个 TagNode 带 role 维度）
DataSource  1───n Report
Report      1───n ReportPlacement    （每个 role 各一个挂载点）
Report      1───n Requirement
Report      1───n SqlVersion
Report      1───n RunRecord
TagNode     1───n ReportPlacement
TagNode     self─n TagNode           （parent_id，根节点与回收站节点为内置）
```

### 3.2 表结构（平台元数据库）

#### `application`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | PK | |
| host | string | 主机头 |
| path_prefix | string | 目录前缀，如 `/sales` |
| name | string | 展示名 |
| status | enum | `ACTIVE` / `DISABLED` |
| **is_platform_root** | bool | 平台根应用标记，全局唯一且不可删除/停用（Q-08 / REQ-ACC-13） |
| settings_json | json | 见下表 |

> 唯一索引：`(host, path_prefix)`
> 约束：`is_platform_root = true` 的记录全局唯一。

**`settings_json` 配置项（Q-\* 收敛后补齐）**

| 键 | 默认值 | 说明 | 关联 |
|---|---|---|---|
| `maxRows` | 50000 | 单次查询行数上限 | REQ-SEC-03 |
| `timeoutMs` | 30000 | 执行超时 | REQ-SEC-03 |
| `exportFileTtlHours` | 24 | 导出文件 TTL | Q-04 |
| `exportHistoryDays` | 30 | 我的导出历史保留天数 | Q-09 |
| `purgeGraceDays` | 7 | 物理删除宽限期（0~30，0=立即） | Q-06 / REQ-LIFE-15 |
| `clientCanViewSql` | false | 甲方是否可见当前生效 SQL | Q-02 / REQ-META-07 |
| `llm.endpoint` / `llm.model` / `llm.apiKeyEnc` | 无 | SQL 生成服务接入（apiKey 加密） | Q-07 / REQ-GEN-08 |
| `embedMode` | false | 无边框嵌入模式 | Q-10 |

#### `data_source`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | PK | |
| app_id | FK | |
| name | string | |
| type | enum | `MYSQL`（一期） |
| host / port / database_name | string/int | |
| username | string | |
| password_enc | blob | 加密存储，接口永不返回 |
| readonly_enforced | bool | 默认 true |
| max_rows | int | 默认 50000 |
| timeout_ms | int | 默认 30000 |
| sensitive_columns_json | json | 脱敏列策略 |
| catalog_refreshed_at | datetime | |

#### `report`（核心：双轨状态就在这张表）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | PK | |
| app_id | FK | |
| name | string | 应用内唯一 |
| description | text | |
| data_source_id | FK | |
| current_sql_version_id | FK | 当前生效 SQL |
| **client_state** | enum | `NORMAL` / `RECYCLED` / `PURGED` |
| **developer_state** | enum | `NORMAL` / `RECYCLED` / `PURGED` |
| client_recycled_at / client_purged_at | datetime | |
| developer_recycled_at / purge_due_at | datetime | 宽限期到期时间 |
| created_by_role | enum | |
| created_at / updated_at | datetime | |

> 索引：`(app_id, client_state)`、`(app_id, developer_state)`
> **设计要点**：两个状态字段同表同记录，天然满足 REQ-LIFE-13 的独立性，也便于 REQ-LIFE-14 的一致性检查。

#### `tag_node`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | PK | |
| app_id | FK | |
| **role** | enum | `CLIENT` / `DEVELOPER` —— 两棵树的区别仅在此 |
| parent_id | FK(nullable) | 根为 null |
| name | string | |
| kind | enum | `ROOT` / `NORMAL` / `RECYCLE_BIN` |
| sort_order | int | |
| depth | int | 限 5 |

> 约束：每个 `(app_id, role)` 有且仅有一个 `ROOT` 与一个 `RECYCLE_BIN`；`RECYCLE_BIN` 不可删除/重命名/移动（REQ-TAG-03）。

#### `report_placement`（挂载点，双轨制的落地点）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | PK | |
| report_id | FK | |
| tag_node_id | FK | 当前挂载目录 |
| role | enum | 与 tag_node.role 一致 |
| origin_parent_id | FK(nullable) | 入回收站前的原父节点（供还原） |
| recycled_at | datetime | |

> 唯一索引：`(report_id, role)` —— 一份报表在每个角色树下**只有一个**挂载点，避免同一报表在同棵树出现两次。

#### `requirement`
| 字段 | 类型 | 说明 |
|---|---|---|
| id | PK | |
| report_id | FK(nullable) | 临时导出场景可为空 |
| author_role | enum | |
| client_key | string | 匿名留痕 |
| content | text | |
| status | enum | `OPEN` / `IN_PROGRESS` / `PENDING_CONFIRM` / `CONFIRMED` / `REJECTED` |
| created_at | datetime | |

#### `sql_version`（追加不可变）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | PK | |
| report_id | FK | |
| sql_text | text | **含 `{{param}}` 占位符的模板**，不含字面量 |
| params_schema_json | json | 参数定义，结构见下（Q-03） |
| author_role | enum | |
| prev_version_id | FK(nullable) | 前版本引用 |
| checksum | string | 去重与比对 |
| created_at | datetime | |

**`params_schema_json` 结构**

```json
{
  "params": [
    {
      "name": "start_date",
      "type": "date",
      "required": true,
      "default": "lastMonth",
      "label": "起始日期"
    },
    {
      "name": "region",
      "type": "enum",
      "required": true,
      "options": ["华东", "华南", "华北"],
      "label": "大区"
    }
  ]
}
```
- 类型枚举：`string` / `number` / `date` / `enum`
- `date` 类型支持的 `default` 预设：`last7d` / `last30d` / `thisMonth` / `lastMonth`
- 保存 SQL 时由解析器自动生成，开发者可在 UI 上微调 `label` 与 `options`（REQ-PARAM-02）

#### `run_record` / `audit_log`
| 字段 | 说明 |
|---|---|
| app_id, role, client_key, report_id | 主体 |
| sql_text | 完整执行文本（含改写后） |
| source | `PREVIEW` / `EXPORT` / `SAVE` / `DEV_DEBUG` |
| result | `SUCCESS` / `FAILED` / `REJECTED` |
| error_code, duration_ms, row_count | |
| started_at | 分区键，保留 180 天 |

#### `export_task`
| 字段 | 说明 |
|---|---|
| app_id, report_id(nullable), sql_text, params_json, format | |
| **client_key** | 发起方匿名标识，支撑「我的导出历史」（Q-09） |
| status | `RUNNING` / `DONE` / `FAILED` / `EXPIRED` |
| file_key, row_count, expires_at | TTL 24h |

> 索引：`(app_id, client_key, started_at)` —— 导出历史查询走此索引；任务记录保留 72 小时后清理，历史列表依赖该索引的 30 天窗口。

---

## 4. 核心状态机

### 4.1 双轨生命周期（DP-1）

```
                   ┌────────────────── 甲方轨 client_state ─────────────────┐

   [保存报表] ──▶ NORMAL ──(甲方删除)──▶ RECYCLED ──(甲方还原)──▶ NORMAL
                    │                       │
                    │                       └──(甲方清空)──▶ PURGED ──(开发者"恢复甲方可见")──▶ RECYCLED
                    │                                            │
                    └──────────────(开发者清空 ⇒ 物理删除)────────┘

                   ┌──────────────── 开发者轨 developer_state ───────────────┐

   [保存报表] ──▶ NORMAL ──(开发者删除)──▶ RECYCLED ──(开发者还原)──▶ NORMAL
                    │                       │
                    │                       └──(开发者清空)──▶ PURGED ⇒ 物理删除整条报表记录
                    │                                            （含甲方轨一并消失）
                    └──────────────(开发者清空 ⇒ 物理删除)────────┘
```

**状态迁移真值表**（`Report` 是否对某角色可见 / 是否在菜单）

| client_state | 甲方列表 | 甲方菜单 | 甲方回收站 | 开发者可见 |
|---|---|---|---|---|
| NORMAL | ✅ | ✅ | — | ✅ |
| RECYCLED | ❌ | ❌ | ✅ | ✅ |
| PURGED | ❌ | ❌ | ❌ | ✅（带「甲方已不可见」标识） |

| developer_state | 开发者列表 | 开发者菜单 | 开发者回收站 | 甲方可见 |
|---|---|---|---|---|
| NORMAL | ✅ | ✅ | — | 取决于 client_state |
| RECYCLED | ❌ | ❌ | ✅ | 取决于 client_state（不受影响） |
| PURGED | — | — | — | 记录物理删除，两轨皆不可见 |

### 4.2 标签树与挂载点

```
甲方树 (role=CLIENT)                     开发者树 (role=DEVELOPER)
└── 根(ROOT)                             └── 根(ROOT)
    ├── 销售/                                ├── 客户A/
    │   └── 月度门店销售(R)                   │   └── 月度门店销售(R)
    ├── 人力/                                ├── 客户B/
    └── 🗑 回收站(RECYCLE_BIN)               └── 🗑 回收站(RECYCLE_BIN)
        └── 旧报表(X) [原路径: 销售/]            └── 弃用报表(Y) [原路径: 客户B/]
```

- 同一份报表 R 在两棵树中**各有一个 `report_placement`**，位置可完全不同（REQ-TAG-02/05）。
- 两棵树的报表**全集相同**（P-20），差异只在组织方式与生命周期状态。
- 进入回收站 = `report_placement.tag_node_id` 指向 `RECYCLE_BIN` + 对应轨状态置 `RECYCLED` + 写入 `origin_parent_id`。

---

## 5. 关键流程

### 5.1 主路径：提示词 → 预览 → 导出 / 保存

```
CLIENT                  GenerationSvc          SqlGateway          MySQL
  │  提示词+数据源          │                       │                  │
  ├──────────────────────▶ │                       │                  │
  │                        │ ① 取 Catalog 元数据    │                  │
  │                        │ ② 调 LLM（仅元数据+提示词）                 │
  │                        │ ③ parse → validate    │                  │
  │                        ├──────────────────────▶│                  │
  │                        │                       │ ④ rewrite(LIMIT) │
  │                        │                       │ ⑤ 只读事务执行 ──▶│
  │  ◀── 200 行样例 + 列结构 ──────────────────────┤                  │
  │                        │                       │                  │
  ├── 分叉 A：仅导出 ─────▶│ 完整查询(max_rows) → 写文件 → TTL 24h      │
  │                        │ 不写 report 表 ✔                          │
  │                        │                                          │
  └── 分叉 B：保存 ───────▶│ 写 report(双轨=NORMAL)                    │
                           │ 写 report_placement ×2（两棵树根）         │
                           │ 写 requirement ×1 + sql_version ×1        │
```

### 5.2 协作降级：需求 → 开发者改 SQL → 甲方确认

```
CLIENT ──求助开发者──▶ requirement(OPEN)
                          │
DEVELOPER 打开需求 ◀───────┘  （展示：原始需求 + 历史沟通 + 当前 SQL + 上次预览结果）
   │
   ├─ 修改 SQL → 新增 sql_version(不可变) → report.current_sql_version_id 前移
   │             ⇒ 甲方刷新即得新结果（无发布环节，REQ-COL-03）
   ├─ 标记完成 → requirement.status = PENDING_CONFIRM
   │
CLIENT 确认通过 → CONFIRMED（记录 clientKey + 时间）
CLIENT 驳回     → OPEN（保留本轮 SQL 版本，REQ-COL-06）
```

### 5.3 删除 / 还原 / 清空

```
甲方删除  → client_state=RECYCLED, placement→RECYCLE_BIN, origin_parent_id=原父
甲方还原  → IF 原父存在 THEN placement←原父 ELSE placement←ROOT（并提示）
甲方清空  → client_state=PURGED（记录物理存在，开发者可见+徽标）
开发者删除→ developer_state=RECYCLED, placement→开发者 RECYCLE_BIN
开发者清空→ 二次确认 → developer_state=PURGED → [宽限期 purgeGraceDays] → 物理删除
                └─ CASCADE: report_placement, requirement, sql_version, run_record, export_task
```

### 5.4 参数化执行（Q-03）

```
用户填参数表单
   │
   ▼
① 取值校验：类型 / 必填 / enum 选项 / date 预设展开      ← 失败则返回字段级错误（REQ-PARAM-06）
   │
   ▼
② 占位符替换（仅在执行层内部）：
   sql_text 中的 {{name}} → 预编译占位符 ?
   参数值以独立数组传递，**绝不拼回 SQL 文本**（REQ-PARAM-05）
   │
   ▼
③ 走与无参数 SQL 完全相同的五道闸（Parse / Validate / Rewrite / Execute / Shape）
   │
   ▼
④ 审计：分别落库 sql_template 与 params_json（敏感值脱敏）
```

**要点**：SQL 网关只有一种执行入口 `execute(sqlTemplate, params)`。无参数 SQL 调用时 `params` 为空数组，但依然走预编译通道（REQ-PARAM-07），避免「有参数走安全路径、无参数走拼接路径」的分裂实现。

---

## 6. 接口契约（HTTP/JSON 概要）

> 统一前缀：`/{host}/{pathPrefix}/{c|d}/api`
> 所有请求由 L0 注入 `RoleContext`，服务端重算角色。

| 方法 | 路径 | 角色 | 说明 | 关联需求 |
|---|---|---|---|---|
| GET | `/applications/current` | 两者 | 当前应用与角色上下文 | REQ-ACC-03 |
| GET | `/data-sources` | DEV | 数据源列表（凭据字段不返回） | REQ-DS-03 |
| POST | `/data-sources` | DEV | 新建数据源 | REQ-DS-01 |
| POST | `/data-sources/{id}/test` | DEV | 测试连接 + 只读校验 | REQ-DS-02 |
| POST | `/data-sources/{id}/catalog:refresh` | DEV | 刷新元数据 | REQ-DS-04 |
| POST | `/reports:generate` | 两者 | 提示词 → 候选 SQL（不执行） | REQ-GEN-01 |
| POST | `/reports:preview` | 两者 | 执行预览（≤200 行） | REQ-GEN-03 |
| POST | `/exports` | 两者 | 发起导出（同步/异步） | REQ-EXP-01/02 |
| GET | `/exports/{id}` | 两者 | 查询导出任务与下载链接 | REQ-EXP-04 |
| POST | `/reports` | 两者 | 保存为常用报表 | REQ-SAVE-01/02 |
| GET | `/reports` | 两者 | 报表列表（按当前角色轨过滤） | REQ-LIFE-07 |
| GET | `/reports/{id}` | 两者 | 详情（SQL 字段对 CLIENT 403） | REQ-META-04 |
| PUT | `/reports/{id}/sql` | DEV | 修改 SQL（新增版本） | REQ-COL-03 |
| GET | `/tag-tree` | 两者 | 当前角色标签树（含回收站，菜单渲染时过滤） | REQ-TAG-01/09 |
| POST | `/tag-tree/nodes` | 两者 | 新建目录 | REQ-TAG-04 |
| POST | `/reports/{id}:move` | 两者 | 移动报表（仅影响本角色树） | REQ-TAG-05 |
| POST | `/reports/{id}:delete` | 两者 | 移入本角色回收站 | REQ-LIFE-02/09 |
| POST | `/reports/{id}:restore` | 两者 | 还原（原父失效则落根） | REQ-LIFE-04/05 |
| POST | `/recycle-bin:purge` | 两者 | 清空（甲方=不可见；开发者=物理删除） | REQ-LIFE-06/10 |
| POST | `/reports/{id}:restore-client-visibility` | DEV | 恢复甲方可见至甲方回收站 | REQ-LIFE-16 |
| GET | `/reports/{id}/requirements` | 两者 | 甲方只见自己的；开发者见全部 | REQ-META-02/03 |
| GET | `/reports/{id}/sql-versions` | DEV | SQL 版本历史 | REQ-META-03/05 |
| GET | `/requirements/inbox` | DEV | 需求收件箱 | REQ-COL-07 |
| POST | `/requirements/{id}:complete` | DEV | 标记完成 | REQ-COL-04 |
| POST | `/requirements/{id}:confirm` | CLIENT | 甲方确认/驳回 | REQ-COL-05/06 |

**统一错误结构**：`{ code, message, traceId }`，不回显堆栈与连接信息（REQ-NFR-06）。

---

## 7. 关键设计决策（ADR 摘要）

| ID | 决策 | 备选方案 | 选择理由 |
|---|---|---|---|
| ADR-01 | 双状态字段同表（`client_state` + `developer_state`） | 单状态 + 可见性位图 / 两张影子表 | 状态机清晰、查询简单、一致性检查容易；两轨独立天然满足 P-08/P-18/P-19 |
| ADR-02 | 每个角色一棵独立标签树 + `report_placement` 记录挂载点 | 共享一棵树 + 每节点双可见标记 | 甲方可自由重组目录而不污染开发者视图（P-20）；挂载点唯一索引防重复 |
| ADR-03 | 还原依赖 `origin_parent_id`，失效则落根目录 | 还原失败并报错 | 避免报表「丢失」，符合 REQ-LIFE-05 |
| ADR-04 | 开发者清空 = 物理删除 + 默认 7 天宽限期 | 立即硬删除 | 不可逆操作需可撤销窗口（Q-06），降低误操作成本 |
| ADR-05 | SQL 校验放在「解析后的 AST」而非字符串匹配 | 正则黑名单 | 字符串匹配可被注释、大小写、编码绕过；AST 更可靠 |
| ADR-06 | LIMIT/超时在 Rewriter 阶段强制注入，优先于 SQL 自带值 | 信任用户 SQL 的 LIMIT | 防止 `LIMIT 1000000` 拖垮数据库（REQ-SEC-03） |
| ADR-07 | NL2SQL 只上传元数据 + 提示词，禁止上传业务数据 | 上传样例数据提升准确率 | 准确率可以用「字段注释 + 多轮修正」补偿，数据外泄不可接受 |
| ADR-08 | 元数据缓存于平台元数据库 | 每次实时查 information_schema | 降低业务库压力，加快生成 |
| ADR-09 | 平台元数据库与业务库物理隔离，账号不复用 | 共用库 | 平台库被注入时不能直接横扫业务库 |
| ADR-10 | 免登录 + 匿名 `clientKey` 留痕 | 简易口令 / 网关 SSO | 遵循 P-12；用审计与只读账号补偿（SEC-10 作为部署约束） |
| ADR-11 | 导出文件 TTL 24h，超 5 万行转异步 | 一律同步 | 80% 场景是小结果，同步体验好；长尾用异步兜底 |
| ADR-12 | SQL 版本追加不可变，历史只读 | 覆盖式保存 + 单独历史表 | 简化模型，天然满足 REQ-COL-06（驳回后历史不丢） |
| **ADR-13** | **参数绑定是唯一执行方式**（`execute(sqlTemplate, params)`，无参数时 params 为空数组） | 有参数走预编译、无参数走拼接 | 双路径实现必然在某一路径上漏掉校验；单入口让 REQ-SEC-08 无法被绕过（Q-03） |
| **ADR-14** | **平台根应用（`is_platform_root`）承载应用管理** | 新增 platform_admin 角色 / 纯配置文件初始化 | 不破坏「只有两个角色」的 P-09；治理入口挂在一个特殊应用上（Q-08） |
| **ADR-15** | **甲方 SQL 可见性做成应用级开关**，默认关闭 | 硬编码不可见 / 一律可见 | 表结构外泄是默认态更安全，技术型甲方需要时再开（Q-02） |
| **ADR-16** | **公网场景不实现认证，交给反向代理层** | 平台内加应用级令牌 | 令牌本质是变形登录，违反 P-12；边界认证是正确的职责归属（Q-01） |

---

## 8. 安全设计（对应 REQ-SEC-\*）

### 8.1 SQL 执行五道闸

```
① Parse     ：SQL → AST，拒绝多语句与解析失败
② Validate  ：白名单语句类型（SELECT / WITH...SELECT）
               黑名单关键字（DML/DDL/TCL/文件读写/延时函数）
               对象级：禁止访问 mysql.* / information_schema 越权 / 非授权库
③ Rewrite   ：注入 LIMIT min(用户值, max_rows)、语句超时、只读会话属性
④ Execute   ：预编译占位符 + 参数绑定；只读连接池 + SET SESSION TRANSACTION READ ONLY
⑤ Shape     ：敏感列脱敏（预览与导出一致）
```
任何一道失败 → 返回 `REJECTED` + 规则编号 → 写审计日志 → 不触达数据库。

### 8.2 凭据与隔离

- 数据源密码加密存储（应用级密钥或 KMS），**所有接口响应中删除该字段**（DTO 层剥离，非前端过滤）。
- 连接池按 `dataSourceId` 隔离；连接建立后校验当前会话无 `INSERT/UPDATE/DELETE` 权限。
- 应用之间数据完全隔离：`app_id` 作为所有查询的强制过滤维度，在数据访问层统一织入。

### 8.3 免登录的风险补偿清单（部署检查项）

| 风险 | 补偿控制 |
|---|---|
| 任何人可访问 | 内网部署 / 网关 SSO / IP 白名单（REQ-SEC-10） |
| 无法问责 | `clientKey` + 审计日志留存 180 天 |
| 越权改数据 | 只读账号 + 只读事务 + 语句白名单 |
| 拖垮业务库 | 并发上限 5 / 频率 30 次每分钟 / 行数 5 万 / 超时 30s |
| 数据外泄 | 仅元数据出网；导出文件 TTL；脱敏列 |
| 注入攻击 | AST 校验 + 参数绑定（REQ-SEC-08） |

---

## 9. 数据保留与清理

| 对象 | 保留策略 |
|---|---|
| 审计日志 / 运行记录 | 180 天，按月分区滚动清理 |
| 导出文件 | 24 小时 TTL，定时清理任务 |
| SQL 版本 / 需求 | 随报表生命周期；报表物理删除时级联清除 |
| 宽限期内的待删报表 | 7 天（可配置），到期由定时任务执行物理删除 |
| 平台元数据库备份 | 每日全量，保留 30 天 |

---

## 10. 决策收敛后的设计状态

> Q-01 ~ Q-10 已于 2026-10-02 全部收敛，完整记录见 `03-decisions.md`。本节说明各结论**落到设计上的最终形态**。

| Q-ID | 结论 | 在设计中的落点 |
|---|---|---|
| Q-01 公网部署 | 不实现认证，交给网关 | 无新增模块；新增「发布前置检查清单」（`03-decisions.md` §2.1）作为强制项 |
| Q-02 甲方可见 SQL | 应用级开关，默认关 | `settings_json.clientCanViewSql`；`GET /reports/{id}` 按开关决定是否返回 `currentSql`；历史版本恒定 403 |
| Q-03 报表参数 | 一期实现，强制参数绑定 | 新增 §5.4 与 `params_schema_json`；SQL 网关单入口 `execute(sqlTemplate, params)`；ADR-13 |
| Q-04 导出 | xlsx + csv，5 万行 / 30s 分界 | `export_task` 已有 `status` 与 `expires_at`；新增 `EXPIRED` 状态 |
| Q-05 开发者代恢复 | 支持，只恢复到 `RECYCLED` | 接口 `POST /reports/{id}:restore-client-visibility` 已定义（REQ-LIFE-16） |
| Q-06 宽限期 | 默认 7 天，可配 0~30 | `purgeGraceDays`；定时任务按 `purge_due_at` 扫描；配 0 时立即物理删除 |
| Q-07 模型 | 应用级配置，默认私有化 | `settings_json.llm.*`；LLM 客户端封装为可替换组件；出站审计（REQ-GEN-10） |
| Q-08 应用创建 | 平台根应用 | `application.is_platform_root`；新增接口 `POST /applications`、`POST /applications/{id}:disable` |
| Q-09 导出历史 | 进审计 + 我的导出历史 | `export_task.client_key` 与索引 `(app_id, client_key, started_at)`；新增 `GET /exports/mine` |
| Q-10 iframe 嵌入 | 无边框 + postMessage，建议同域反代 | `settings_json.embedMode`；前端在 `embedMode` 下去掉外壳并 postMessage 高度 |

### 10.1 新增接口（收敛后补充）

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | `/applications` | DEV（仅平台根应用） | 创建应用并初始化两棵标签树 |
| POST | `/applications/{id}:disable` | DEV（仅平台根应用） | 停用应用 |
| GET | `/exports/mine` | 两者 | 我的导出历史（30 天） |
| POST | `/exports/{id}:rerun` | 两者 | 过期任务重跑 |
| GET | `/reports/{id}/params` | 两者 | 获取当前 SQL 的参数定义，用于渲染表单 |

---

## 11. 下一阶段（Code）建议的落地顺序

| 阶段 | 内容 | 依赖 |
|---|---|---|
| S1 | 平台元数据库建表 + **平台根应用初始化** + `application` / `data_source` 管理 | — |
| S2 | SQL 网关五道闸 + **参数绑定单入口 `execute(sqlTemplate, params)`** + 数据源适配器 | S1 |
| S3 | 提示词生成 → 预览 → 导出（主路径 80%）+ 我的导出历史 | S2 |
| S4 | **报表参数：占位符解析、参数表单、预设值** | S3 |
| S5 | 保存为常用报表 + 标签树 CRUD + 移动 | S3 |
| S6 | 双轨生命周期 + 两个回收站 + 还原/清空/宽限期 | S5 |
| S7 | 需求协作闭环 + SQL 版本留痕 + 可见性分级（`clientCanViewSql`） | S5 |
| S8 | 审计、限流、脱敏、**发布前置检查清单**、嵌入模式 | S2~S7 |

> Q-11 ~ Q-15（见 `03-decisions.md` §4）不阻塞 S1~S3，建议在 S4 之前收敛。
