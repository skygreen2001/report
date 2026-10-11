# 企业报表平台（report-platform）

面向企业内部、**免登录**的轻量报表平台。核心路径是「提示词生成 SQL → 预览 → 导出或沉淀为常用报表」，并提供「甲方提需求 / 开发者改 SQL / 甲方确认」的协作降级通道。

- **甲方（CLIENT）**：零配置，直接消费报表 —— 输提示词、预览、导出、保存、自建目录。
- **开发者（DEVELOPER）**：配置数据源、编写与修改 SQL、处理甲方需求、拥有最终删除权。

无注册、无登录、无用户体系：**角色由访问路径决定**，多应用通过「域名 + 目录前缀」隔离。

---

## 一句话理解

```
http://<host>/<appPath>/c/...   →  甲方入口
http://<host>/<appPath>/d/...   →  开发者入口
```

本机示例：`http://localhost:3000/demo/c`（甲方）、`http://localhost:3000/demo/d`（开发者）。

---

## 核心特性

| 特性 | 说明 |
|---|---|
| NL2SQL 主路径 | 提示词 → 候选 SQL → 安全校验 → 预览（默认 200 行）→ **仅导出**（主路径，约 80%）或**保存为常用报表** |
| SQL 安全网关 | 全项目**唯一执行入口** `execute(template, params)`；Parse → Validate → Rewrite → Execute → Shape 五道闸 |
| 强制参数绑定 | `{{param}}` 占位符只能出现在 WHERE/HAVING/LIMIT 的值位置，执行层只接受「模板 + 参数值」，杜绝拼接注入 |
| 双轨生命周期 | 每份报表有 `client_state` / `developer_state` 两条独立生命周期（`NORMAL`/`RECYCLED`/`PURGED`） |
| 双层回收站 | 甲方「清空」＝对甲方永久不可见、开发者仍可见；开发者「清空」＝物理删除（默认 7 天宽限期可撤销） |
| 双标签树 | 每个「应用 × 角色」一棵独立目录树，结构变更互不影响；每棵树含一个内置回收站节点 |
| 协作闭环 | 甲方求助 → 开发者改 SQL → 甲方刷新即见新结果 → 确认/驳回；需求与 SQL 版本全程留痕 |
| 导出 | xlsx / csv；超 5 万行或 30 秒转异步任务；文件 TTL 24h，支持「我的导出历史」与过期重跑 |
| 嵌入模式 | `embedMode` 无边框 + postMessage 高度自适应，可 iframe 嵌入宿主系统 |

---

## 技术栈

Next.js 15（App Router）+ TypeScript + MySQL 8+（Node 22 LTS）。单机单进程部署，**除 MySQL 外无其他基础设施**。

| 领域 | 选型 |
|---|---|
| 数据库驱动 | `mysql2`（prepared statement + 流式读取） |
| SQL 解析 | `node-sql-parser`（AST 白名单校验，非正则黑名单） |
| 导出 | `exceljs` 流式 writer + 自写 CSV（含公式注入防护） |
| 参数校验 | `zod` |
| LLM | `openai` SDK，`baseURL` 可配，兼容私有化 / vLLM / DeepSeek 等端点 |
| 凭据加密 | `node:crypto` AES-256-GCM |
| 缓存 / 限流 / 异步任务 | 进程内 `Map` + TTL、进程内令牌桶、表轮询 worker |

---

## 目录结构

```
report/
├─ docs/
│  ├─ 技术方案.md          # 落地技术指南（选型、目录、代码骨架、陷阱、运维）
│  └─ spec/
│     ├─ 00-prompt.md      # 原始需求 22 条、假设、术语表
│     ├─ 01-requirements.md# 113 条 EARS 需求（实现时逐条对照）
│     ├─ 02-design.md      # 领域模型、状态机真值表、ADR-01~16
│     └─ 03-decisions.md   # Q-01~Q-15 决策结论与依据
└─ report-platform/
   ├─ schema.sql           # 平台元库建表（可直接 mysql < schema.sql）
   ├─ next.config.mjs
   ├─ .env.local           # 环境变量（需自行创建）
   ├─ data/exports/        # 导出文件目录（TTL 清理）
   ├─ scripts/             # 基础设施、种子数据、验证与冒烟脚本
   ├─ test/                # SQL 网关单测
   └─ src/
      ├─ middleware.ts     # Edge：rewrite + clientKey Cookie（不查库）
      ├─ app/tenant/[appPath]/[role]/…   # 页面 + API Route Handlers
      ├─ server/
      │  ├─ context.ts     # RoleContext（每次请求重算，不信任前端角色）
      │  ├─ sql/           # ★ 网关：parser / validator / rewriter / executor / shape / gateway
      │  ├─ services/      # application / datasource / report / tagTree / lifecycle / export / generation / …
      │  └─ db/            # 平台元库连接池 + 业务只读库连接池（DataSourceAdapter 适配点）
      └─ lib/types.ts
```

---

## 快速开始

### 前置条件

- Node.js 22 LTS
- MySQL 8+（本机或可达实例），需要一个有建库权限的账号

### 1. 安装依赖

```bash
cd report-platform
npm install
```

### 2. 初始化数据库

```bash
# ① 平台元库建表（report_platform）
mysql -uroot -proot -h127.0.0.1 -P3306 < schema.sql

# ② 业务只读库 biz_demo + 只读账号 report_ro + 演示数据
npm run setup:infra
```

> 只读账号仅 `GRANT SELECT`，是安全模型的地基：业务库连接强制走只读账号，`INSERT/UPDATE/DROP` 天然失败。

### 3. 配置环境变量

创建 `report-platform/.env.local`：

```bash
# ===== 平台元库 =====
PLATFORM_DB_HOST=127.0.0.1
PLATFORM_DB_PORT=3306
PLATFORM_DB_NAME=report_platform
PLATFORM_DB_USER=root
PLATFORM_DB_PASSWORD=root

# ===== 业务只读库（与元库物理隔离、账号不复用）=====
BIZ_DB_HOST=127.0.0.1
BIZ_DB_PORT=3306
BIZ_DB_NAME=biz_demo
BIZ_DB_USER=report_ro
BIZ_DB_PASSWORD=ReportRo@2026

# ===== 凭据加密（AES-256-GCM，32 字节 base64）=====
# 生成：openssl rand -base64 32
APP_ENC_KEY=<your-32-bytes-base64>

# ===== 导出文件目录 =====
EXPORT_DIR=./data/exports

# ===== LLM（OpenAI 兼容端点，可指向私有化部署）=====
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat

# ===== 网关默认参数（可被应用 settings 覆盖）=====
DEFAULT_MAX_ROWS=200
DEFAULT_TIMEOUT_MS=15000
```

> `APP_ENC_KEY` 用于加密数据源密码，一旦更换，已保存的数据源凭据将不可解密。

### 4. 灌入种子数据

```bash
npm run seed
```

会创建：平台根应用（`platform`）、示例应用（`demo`）、只读数据源、两棵标签树、一份示例报表。

### 5. 启动

```bash
npm run dev     # http://localhost:3000
npm run build && npm start   # 生产
```

访问：

| 入口 | URL |
|---|---|
| 甲方 | http://localhost:3000/demo/c |
| 开发者 | http://localhost:3000/demo/d |
| 平台根应用（管理其他应用） | http://localhost:3000/platform/d |

---

## 本地大模型配置（推荐）

平台支持本地部署大模型来生成 SQL，数据不出本机、无需购买云端 API。

### 推荐配置

- **内存 ≥ 16G**

### 安装步骤

1. 安装 [Ollama](https://ollama.com)（macOS / Linux / Windows 均支持）。
2. 拉取推荐模型：

   ```bash
   ollama pull qwen2.5-coder:7b-instruct-q4_K_M
   ollama qwen2.5-coder:7b-instruct-q4_K_M
   ```

3. 启动 Ollama（安装后默认随系统启动，或执行 `ollama serve`）。
4. 在企业报表平台（report-platform）的「模型配置」功能菜单中，新增模型并选中预设：**本地 Ollama**，保存即可。

### 推荐理由

| 模型 | 占用内存 | 说明 |
| --- | --- | --- |
| **Qwen2.5‑Coder‑7B‑Instruct** ⭐首选 | ~4.7G | 中文代码能力强，适合写业务 SQL、Debug、重构、生成单元测试；64K 上下文；16G 内存下运行非常流畅 |

> 提示：q4_K_M 为 4-bit 量化版本，显存 / 内存占用低、推理速度快，是 16G 机型上「流畅 + 质量兼顾」的最佳平衡点。

---

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 开发服务器（3000 端口） |
| `npm run build` / `npm start` | 生产构建 / 启动 |
| `npm run typecheck` | `tsc --noEmit` 全量类型检查 |
| `npm run lint` | ESLint |
| `npm test:gateway` | SQL 网关单测（34 条对抗用例） |
| `npm run setup:infra` | 建业务只读库、只读账号与演示数据 |
| `npm run seed` | 灌入平台根应用、示例应用与示例报表 |

端到端验证脚本（需先起服务 / 已 seed）：

```bash
node node_modules/next/dist/bin/next dev -p 3111 &
bash scripts/smoke-http.sh                    # HTTP 冒烟：生成 → 保存 → 预览 → 导出 → 双轨生命周期
node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node .verify-build/scripts/verify.js   # 真实环境网关验证
```

---

## 安全模型（最重要的一节）

**SQL 网关只有一个入口**：`src/server/sql/gateway.ts` 的 `execute(sqlTemplate, params)`。全项目禁止出现第二处执行业务 SQL 的代码，无参数时也传空数组走 prepared statement。

```
SQL 模板 + 参数值
  → ① Parse    {{name}} → ?，校验占位符只在值位置；AST 解析；多语句即拒
  → ② Validate 语句类型白名单（select）、危险函数/系统库/跨库黑名单、去注释后深度扫描
  → ③ Rewrite  AST 覆盖 LIMIT = min(原值, maxRows)；改写失败 fail-closed 直接拒绝
  → ④ Execute  只读事务 + prepared statement + max_execution_time
  → ⑤ Shape    敏感列脱敏（预览与导出一致）
```

其它约束：连接池显式 `multipleStatements: false`；应用级 SQL 并发上限 5、单 clientKey 30 次/分钟；审计日志记录每次执行（含被拒记录）；数据源凭据 AES 加密且**永不返回前端**。

> 免登录不等于无防护。**若部署在公网或非可信网络，必须在前置网关启用 SSO、IP 白名单或访问令牌**（见 `docs/技术方案.md` §14.1 发布前置检查清单）。

---

## API 概览

统一前缀：`/{appPath}/{c|d}/api`。所有接口由服务端重算 `RoleContext`，角色判断只在服务端。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/bootstrap` | 两者 | 应用信息 + 角色 + 本角色标签树 |
| POST | `/applications` | DEV（仅根应用） | 创建应用并初始化两棵树 |
| GET/POST | `/data-sources` | DEV | 列表（不含凭据）/ 新建 |
| POST | `/data-sources/{id}/test` | DEV | 测试连接 + 只读校验 |
| POST | `/reports/generate` | 两者 | 提示词 → 候选 SQL（不执行） |
| POST | `/reports/preview` | 两者 | 预览（≤200 行） |
| POST | `/reports` | 两者 | 保存为常用报表 |
| PUT | `/reports/{id}/sql` | DEV | 改 SQL（追加不可变版本） |
| GET | `/reports/{id}/params` | 两者 | 参数定义 |
| POST | `/reports/{id}:move` / `:delete` / `:restore` | 两者 | 移动 / 移入回收站 / 还原（仅影响本角色树） |
| POST | `/recycle-bin:purge` | 两者 | 清空（甲方＝不可见，开发者＝物理删除） |
| POST | `/exports` · GET `/exports/{id}` · GET `/exports/mine` | 两者 | 发起导出 / 状态下载 / 我的导出历史 |
| GET/POST | `/tag-tree` · `/tag-tree/nodes` | 两者 | 本角色标签树 CRUD |
| GET | `/requirements/inbox` · POST `/requirements/{id}:complete` | DEV | 需求收件箱 / 标记完成 |
| POST | `/requirements/{id}:confirm` | CLIENT | 确认 / 驳回 |

统一错误结构：`{ code, message, traceId }`，`message` 不含堆栈、SQL 细节与连接信息。

---

## 文档索引

| 文档 | 看什么 |
|---|---|
| `docs/spec/00-prompt.md` | 原始需求 22 条、关键假设、术语表 |
| `docs/spec/01-requirements.md` | **113 条 EARS 需求**，实现时逐条对照 |
| `docs/spec/02-design.md` | 领域模型、状态机真值表、ADR |
| `docs/spec/03-decisions.md` | Q-01~Q-15 决策结论与依据 |
| `docs/技术方案.md` | 技术选型、目录结构、代码骨架、陷阱与运维（**落地技术指南**） |
| `report-platform/schema.sql` | 可直接执行的建表语句 |

---

## 已知限制

- **无认证**：换浏览器或清 Cookie 会丢失 `clientKey`，导出历史不可见（一期不做跨设备）。
- **仅 MySQL**：一期只实现 `MysqlAdapter`，其余数据源需新增适配器。
- **仅只读查询**：不支持存储过程、临时表、跨库 JOIN；复杂报表需走视图或数仓预建。
- **不做图表可视化**：一期为表格 + 导出，无图表、仪表盘、定时调度与订阅推送。
- 报表名在应用内全局唯一，已 `PURGED` 的报表同样占用名称。


## 其他

- 在VSCode、CodeBuddy、Trae CN等开发工具的配置设置里，Git提交中英文注释生成模版配置如下:
  ```
    "github.copilot.chat.commitMessageGeneration.instructions": [
        {
            "file": ".workbuddy/rules/git-commit-message.md"
        }
    ]
  ```