# 01 · Requirements（EARS 需求规格）

> **编写方法**：EARS（Easy Approach to Requirements Syntax）
> 每条需求必须且只能使用以下六种句式之一，句式决定了它的语义边界：
>
> | 句式 | 模板 | 用途 |
> |---|---|---|
> | Ubiquitous | 系统 SHALL \<响应\> | 无条件始终成立 |
> | Event-driven | WHEN \<触发\>，系统 SHALL \<响应\> | 由外部事件驱动 |
> | State-driven | WHILE \<状态\>，系统 SHALL \<响应\> | 在某一持续状态下成立 |
> | Unwanted | IF \<异常条件\>，THEN 系统 SHALL \<响应\> | 异常/防御性行为 |
> | Optional | WHERE \<特性被启用\>，系统 SHALL \<响应\> | 与可选项绑定 |
> | Complex | 上述组合（多 WHEN / WHILE + IF） | 复合场景 |
>
> **约束**：禁止使用「应该」「尽量」「支持…等」「适当的」等模糊词；每条需求必须有唯一 ID、可验证的验收要点、以及到 `00-prompt.md` 中 P-/A-/Q- 的追溯。

---

## 1. 应用与访问（ACC）

> 追溯：P-12、P-13、A-02、A-03

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-ACC-01 | Ubiquitous | 系统 SHALL 支持且仅支持两种角色：`DEVELOPER`（开发者）与 `CLIENT`（甲方）。 | 角色枚举仅有两个值；无角色管理界面 |
| REQ-ACC-02 | Ubiquitous | 系统 SHALL 不提供注册、登录、登出、密码找回与用户管理功能。 | 全站不存在账号相关路由与页面 |
| REQ-ACC-03 | Event-driven | WHEN 系统收到一个 HTTP 请求，系统 SHALL 依据「主机头 + 路径前缀」解析出唯一的 `Application`，解析不着则返回「应用不存在」错误页。 | `app.example.com/sales/...` 与 `app.example.com/hr/...` 解析为两个互不可见的应用 |
| REQ-ACC-04 | Event-driven | WHEN 请求路径前缀匹配开发者入口（默认 `/d/`），系统 SHALL 将本次会话的角色上下文置为 `DEVELOPER`。 | 开发者入口可见数据源配置、SQL 编辑、开发者回收站 |
| REQ-ACC-05 | Event-driven | WHEN 请求路径前缀匹配甲方入口（默认 `/c/`），系统 SHALL 将本次会话的角色上下文置为 `CLIENT`。 | 甲方入口不可见数据源配置与 SQL 文本 |
| REQ-ACC-06 | State-driven | WHILE 角色上下文为 `CLIENT`，系统 SHALL 隐藏数据源连接配置、SQL 编辑框与开发者回收站入口。 | 甲方侧接口直接访问 SQL 编辑端点时返回 403 |
| REQ-ACC-07 | Unwanted | IF 一个已解析的 `Application` 处于停用状态，THEN 系统 SHALL 拒绝所有数据访问并返回停用提示，且 SHALL 不泄露该应用下的任何报表名称或库表信息。 | 停用应用返回统一占位页 |
| REQ-ACC-08 | Ubiquitous | 系统 SHALL 为每个访问端生成并持久化一个本地匿名标识 `clientKey`，用于操作留痕。 | 审计记录中包含 clientKey |
| REQ-ACC-09 | Optional | WHERE 平台以 iframe 嵌入宿主系统，系统 SHALL 提供无边框模式，并通过 postMessage 上报内容高度以支持宿主自适应。 | 宿主页面无滚动条嵌套 |
| REQ-ACC-10 | Ubiquitous | 系统 SHALL 内置一个平台根应用（`is_platform_root = true`），其 `DEVELOPER` 角色可在其中创建、停用其他应用并配置其域名与目录前缀。 | 除平台根应用外，不提供任何更高权限入口（Q-08） |
| REQ-ACC-11 | Event-driven | WHEN 开发者创建一个应用，系统 SHALL 校验 `(host, path_prefix)` 组合未被占用，并 SHALL 自动为该应用初始化甲方与开发者两棵标签树的根节点与回收站节点。 | 新应用立即可用 |
| REQ-ACC-12 | Unwanted | IF 新建应用的域名与目录前缀与既有应用冲突或存在嵌套，THEN 系统 SHALL 拒绝创建并列出冲突的应用名称。 | 路由歧义不产生 |
| REQ-ACC-13 | Unwanted | IF 请求删除或停用平台根应用，THEN 系统 SHALL 拒绝该操作。 | 根应用硬保护（Q-14） |

---

## 2. 数据源管理（DS）

> 追溯：P-10、P-11、A-05、A-06

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-DS-01 | Ubiquitous | 系统 SHALL 将数据源的增、删、改、测试连接能力限定为 `DEVELOPER` 角色可用。 | 甲方调用相关接口返回 403 |
| REQ-DS-02 | Ubiquitous | 系统 SHALL 在数据源配置中强制使用只读数据库账号，并 SHALL 在「测试连接」时校验该账号不具备写权限。 | 用具备写权限的账号测试连接时明确报错 |
| REQ-DS-03 | Event-driven | WHEN 开发者保存数据源配置，系统 SHALL 对连接凭据（用户名、密码）执行加密存储，并 SHALL 永不通过任何接口将其返回至前端。 | 抓包检查所有响应体不含密码字段 |
| REQ-DS-04 | Event-driven | WHEN 数据源配置新增或表结构发生变更，系统 SHALL 抓取并缓存该数据源的库/表/字段/注释元数据（Catalog），供提示词生成 SQL 使用。 | 元数据可被手动「刷新」 |
| REQ-DS-05 | Unwanted | IF 测试连接失败或超时超过 10 秒，THEN 系统 SHALL 返回归类后的错误原因（网络不可达 / 认证失败 / 库不存在），且 SHALL 不在错误信息中回显密码。 | 错误文案脱敏 |
| REQ-DS-06 | Ubiquitous | 系统 SHALL 将数据源的作用域限定在其所属的 `Application` 内，跨应用不可引用。 | 报表只能选择本应用的数据源 |
| REQ-DS-07 | Optional | WHERE 数据源类型为非 MySQL，系统 SHALL 通过数据源适配器接口接入，且 SHALL 在元数据抓取与 SQL 方言改写上由该适配器自行实现。 | 新增一种数据源仅需新增一个适配器实现 |
| REQ-DS-08 | Event-driven | WHEN 开发者删除一个仍被报表引用的数据源，系统 SHALL 阻断删除并列出引用该数据源的报表名称。 | 强制先解引用 |

---

## 3. 提示词生成 SQL 与预览（GEN）

> 追溯：P-02、P-03、A-07、A-08

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-GEN-01 | Event-driven | WHEN 甲方提交自然语言提示词并选定数据源，系统 SHALL 结合该数据源的元数据生成一条候选 SQL 与一段「理解说明」。 | 返回结果含 SQL 摘要与所用表字段说明 |
| REQ-GEN-02 | Event-driven | WHEN 生成候选 SQL 后、执行前，系统 SHALL 依次执行 SQL 安全校验（REQ-SEC-01 至 REQ-SEC-03）；校验不通过时系统 SHALL 不执行该 SQL，并 SHALL 重新生成至多 2 次，仍失败则返回失败原因与「求助开发者」入口。 | 危险 SQL 永不落到执行器 |
| REQ-GEN-03 | Event-driven | WHEN 甲方请求预览，系统 SHALL 以受限行数（默认 200 行）执行该 SQL，并在 30 秒内返回列结构与样例数据。 | 预览响应 ≤ 30s；行数 ≤ 200 |
| REQ-GEN-04 | Unwanted | IF 预览执行失败（语法错误 / 超时 / 权限不足 / 表不存在），THEN 系统 SHALL 返回可读的错误归类与原始 SQL 的**错误位置提示**，并 SHALL 提供「转交开发者」入口。 | 错误可定位；一键转交 |
| REQ-GEN-05 | Ubiquitous | 系统 SHALL 仅将「数据源元数据（库表结构、字段注释）」与「用户提示词」发送给 SQL 生成服务，SHALL 不发送任何业务明细数据。 | 出站请求内容审计通过 |
| REQ-GEN-06 | Ubiquitous | 系统 SHALL 允许甲方在预览界面对候选 SQL 的生成结果提出「修正意见」并触发重新生成，且 SHALL 保留本轮提示词与生成结果于会话上下文中。 | 支持多轮迭代 |
| REQ-GEN-07 | State-driven | WHILE 会话中存在未确认的候选 SQL，系统 SHALL 保持其可导出、可保存、可转交开发者三种后续动作可用。 | 三个动作常驻 |
| REQ-GEN-08 | Ubiquitous | 系统 SHALL 使 SQL 生成服务的接入地址、模型名与凭据由「应用级配置」提供，且 SHALL 支持指向私有化部署的兼容接口。 | 配置可切换，不硬编码厂商（Q-07） |
| REQ-GEN-09 | Unwanted | IF 未配置 SQL 生成服务，或其调用失败、超时，THEN 系统 SHALL 降级为「手动编写 SQL」模式，并 SHALL 向甲方提供「求助开发者」入口。 | 生成服务不可用时平台仍可用 |
| REQ-GEN-10 | Event-driven | WHEN 系统向 SQL 生成服务发起请求，系统 SHALL 记录一条出站审计（应用、请求摘要、时间），且 SHALL 保证请求体中不含任何业务明细数据。 | 出站可审计 |

---

## 4. 导出与临时导出（EXP）

> 追溯：P-03、P-04、P-05、A-10

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-EXP-01 | Event-driven | WHEN 甲方在预览确认后选择「仅导出」，系统 SHALL 执行完整查询并生成导出文件，且 SHALL **不创建**报表记录。 | 执行后报表列表数量不变 |
| REQ-EXP-02 | Ubiquitous | 系统 SHALL 支持 `xlsx` 与 `csv` 两种导出格式，且 SHALL 在单次导出行数超过 50,000 行时自动转为异步导出任务。 | 超限时前端收到任务 ID 而非文件 |
| REQ-EXP-03 | Unwanted | IF 异步导出任务执行失败，THEN 系统 SHALL 将任务标记为失败并保留失败原因，且 SHALL 允许发起一次重试。 | 失败任务可重试一次 |
| REQ-EXP-04 | Event-driven | WHEN 导出文件生成完成，系统 SHALL 为其设置过期时间（默认 24 小时），过期后系统 SHALL 自动清理文件对象。 | 过期链接返回 410 |
| REQ-EXP-05 | Ubiquitous | 系统 SHALL 为每次导出记录审计条目（应用、角色、clientKey、SQL 文本、行数、耗时、时间）。 | 审计表可查 |
| REQ-EXP-06 | State-driven | WHILE 存在未完成的导出任务，系统 SHALL 在页面上展示任务进度与预计行数。 | 进度可见 |
| REQ-EXP-07 | Optional | WHERE 平台配置了导出行数上限阈值，系统 SHALL 在导出前提示预估行数并要求用户确认继续。 | 超限弹确认 |
| REQ-EXP-08 | Ubiquitous | 系统 SHALL 提供「我的导出历史」入口，仅展示当前 `clientKey` 在最近 30 天内的导出任务及其可下载链接。 | 换 clientKey 不可见他人历史（Q-09） |
| REQ-EXP-09 | State-driven | WHILE 导出任务的文件已过期，系统 SHALL 在导出历史中将其标记为「已过期」，并 SHALL 支持基于原 SQL 与参数一键重跑再次导出。 | 过期可重跑，不留死链 |

---

## 5. 报表参数与参数化执行（PARAM）

> 追溯：Q-03（已收敛：一期实现）、P-14
> 设计要点：**参数化不只是交互特性，更是防注入的执行方式**（与 REQ-SEC-08 合并落地）。

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-PARAM-01 | Ubiquitous | 系统 SHALL 支持在 SQL 中以 `{{param_name}}` 占位符声明参数，且 SHALL 使该占位符仅能出现在 `WHERE` / `HAVING` / `LIMIT` 的**值位置**。 | 出现在表名、列名、关键字位置则拒绝 |
| REQ-PARAM-02 | Event-driven | WHEN 一份 SQL 被保存，系统 SHALL 解析出其中全部占位符并生成参数定义（名称、类型、是否必填、默认值），存入该 SQL 版本的 `params_schema`。 | 参数定义自动生成 |
| REQ-PARAM-03 | Ubiquitous | 系统 SHALL 支持四种参数类型：`string` / `number` / `date` / `enum`（单选）。 | 四类均可渲染与校验 |
| REQ-PARAM-04 | Event-driven | WHEN 用户预览或导出一份含参数的报表，系统 SHALL 渲染参数表单，且 SHALL 在全部必填参数填写完成前禁用执行动作。 | 未填完不可执行 |
| REQ-PARAM-05 | Ubiquitous | 系统 SHALL 以**参数绑定（预编译占位符）**方式将参数值传入执行层，SHALL 不将参数值拼接进 SQL 文本。 | 执行层收到的始终是模板 + 值 |
| REQ-PARAM-06 | Unwanted | IF 参数值与其声明类型不匹配或未通过校验规则，THEN 系统 SHALL 拒绝执行并返回字段级错误提示。 | 精确到参数名的报错 |
| REQ-PARAM-07 | Ubiquitous | 系统 SHALL 使参数绑定成为默认执行方式，即便 SQL 中不含任何占位符。 | 无参数 SQL 也走预编译通道 |
| REQ-PARAM-08 | Event-driven | WHEN 渲染 `date` 类型参数，系统 SHALL 提供「最近 7 天 / 最近 30 天 / 本月 / 上月」快捷预设。 | 四种预设可用 |
| REQ-PARAM-09 | Event-driven | WHEN 任意 SQL 被执行，系统 SHALL 在审计日志中分别记录「SQL 模板」与「参数值（敏感参数脱敏后）」，以便事后完整还原。 | 审计可还原现场 |

## 6. 保存为常用报表（SAVE）

> 追溯：P-04、P-05、P-16、P-21

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-SAVE-01 | Event-driven | WHEN 甲方在预览确认后选择「保存为常用报表」，系统 SHALL 创建报表记录，其内容至少包含：名称、描述、数据源、当前 SQL 版本、甲方原始需求文本、创建时间与创建角色。 | 报表详情字段齐全 |
| REQ-SAVE-02 | Event-driven | WHEN 报表创建完成，系统 SHALL 同时在该应用的**甲方标签树**与**开发者标签树**的根路径下各创建一个挂载点。 | 两棵树的根下均可见该报表 |
| REQ-SAVE-03 | Ubiquitous | 系统 SHALL 将新创建报表的甲方生命周期与开发者生命周期均初始化为 `NORMAL`。 | 初始状态正确 |
| REQ-SAVE-04 | Unwanted | IF 保存时未填写报表名称，THEN 系统 SHALL 拒绝保存并提示填写。 | 名称必填 |
| REQ-SAVE-05 | Ubiquitous | 系统 SHALL 在同一应用内校验报表名称不重复；重复时 SHALL 拒绝并提示。 | 名称唯一性（应用内） |
| REQ-SAVE-06 | Event-driven | WHEN 报表被保存，系统 SHALL 生成第一条需求记录（内容为甲方原始提示词或需求说明，作者角色为 `CLIENT`）与第一条 SQL 版本记录（作者角色依据实际生成方标记）。 | 留痕完整 |

---

## 7. 需求协作闭环（COL）

> 追溯：P-06、P-07、P-21、P-22、A-12

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-COL-01 | Event-driven | WHEN 甲方对预览结果执行「求助开发者」，系统 SHALL 将提示词、候选 SQL、预览错误信息（若有）与甲方补充说明组装为一条需求记录并置为「待处理」。 | 需求对象字段完整 |
| REQ-COL-02 | Event-driven | WHEN 开发者打开一条「待处理」需求，系统 SHALL 展示甲方原始需求、历次沟通记录、当前 SQL 与最近一次预览结果。 | 上下文一次性可见 |
| REQ-COL-03 | Event-driven | WHEN 开发者修改并保存报表 SQL，系统 SHALL 使甲方在刷新报表页面后立即获得基于新 SQL 的预览结果，无需任何发布、构建或重启动作。 | 保存后甲方刷新即生效（秒级） |
| REQ-COL-04 | Event-driven | WHEN 开发者将一条需求标记为「已完成」，系统 SHALL 将需求状态置为「待甲方确认」，并 SHALL 在甲方侧生成一条待确认提示。 | 状态流转正确 |
| REQ-COL-05 | Event-driven | WHEN 甲方对「待甲方确认」的需求执行「确认通过」，系统 SHALL 将需求状态置为「已确认」并记录确认时间与确认端 clientKey。 | 留下确认痕迹 |
| REQ-COL-06 | Unwanted | IF 甲方对「待甲方确认」的需求执行「驳回并补充说明」，THEN 系统 SHALL 将需求退回至「待处理」，并 SHALL 保留本轮 SQL 版本作为历史记录不被覆盖。 | SQL 历史不被抹除 |
| REQ-COL-07 | State-driven | WHILE 存在「待处理」需求，系统 SHALL 在开发者侧以独立入口集中展示并支持按提交时间排序。 | 开发者有需求收件箱 |
| REQ-COL-08 | Optional | WHERE 平台配置了通知渠道，系统 SHALL 在需求状态变更时向对应角色发送通知（站内标记 + 邮件或 Webhook）。 | 通知可配置开关 |

---

## 8. 标签管理器与目录树（TAG）

> 追溯：P-15、P-16、P-20

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-TAG-01 | Ubiquitous | 系统 SHALL 为每个「应用 × 角色」组合维护且仅维护一棵标签树，该树根节点为系统内置的根路径。 | 每应用共两棵树 |
| REQ-TAG-02 | Ubiquitous | 系统 SHALL 使甲方标签树与开发者标签树的结构变更互不影响。 | 甲方建目录，开发者树不变 |
| REQ-TAG-03 | Ubiquitous | 每棵标签树 SHALL 包含且仅包含一个内置的「回收站」节点，该节点不可删除、不可重命名、不可移动、不可作为移动目标。 | 四类操作均被拒绝并提示 |
| REQ-TAG-04 | Event-driven | WHEN 用户新建、重命名或删除一个普通目录节点，系统 SHALL 仅影响该操作者所属角色的标签树。 | 隔离验证 |
| REQ-TAG-05 | Event-driven | WHEN 用户将一个报表拖拽或移动到指定目录，系统 SHALL 更新该报表**在其所属角色树中**的挂载点。 | 甲方移动不影响开发者树挂载点 |
| REQ-TAG-06 | Unwanted | IF 用户删除一个仍挂载有报表的目录，THEN 系统 SHALL 弹出显式确认，并要求用户在「将报表移入回收站」与「将报表移至父目录」中择一后执行。 | 不存在静默删除 |
| REQ-TAG-07 | Ubiquitous | 系统 SHALL 限制标签树的最大层级为 5 层（不含根节点与回收站节点）。 | 超限拒绝创建 |
| REQ-TAG-08 | State-driven | WHILE 报表在某角色树中的生命周期为 `RECYCLED`，系统 SHALL 使其挂载点固定在该角色的回收站节点下，且 SHALL 在记录中保留其进入回收站前的原父节点。 | 原路径可追溯 |
| REQ-TAG-09 | Ubiquitous | 系统 SHALL 在左侧菜单仅渲染当前角色标签树中生命周期为 `NORMAL` 的节点与报表。 | 回收站内容不进菜单 |

---

## 9. 双层生命周期与回收站（LIFE）— 核心

> 追溯：P-08、P-17、P-18、P-19、P-20
> 设计要点：**每份报表持有两条彼此独立的可见性生命周期**（甲方生命周期 / 开发者生命周期），各自取值为 `NORMAL` / `RECYCLED` / `PURGED`。

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-LIFE-01 | Ubiquitous | 系统 SHALL 为每份报表维护两条相互独立的可见性生命周期：甲方生命周期（`clientState`）与开发者生命周期（`developerState`），取值集合均为 `{NORMAL, RECYCLED, PURGED}`。 | 数据模型含两个状态字段 |
| REQ-LIFE-02 | Event-driven | WHEN 甲方对一份甲方生命周期为 `NORMAL` 的报表执行「删除」，系统 SHALL 将该报表的甲方生命周期置为 `RECYCLED`，将其在甲方标签树中的挂载点移动到甲方回收站节点，并记录原父节点与删除时间。 | 状态与挂载点同时变更 |
| REQ-LIFE-03 | State-driven | WHILE 报表的甲方生命周期为 `RECYCLED`，系统 SHALL 不将其渲染在甲方左侧菜单中，且 SHALL 在甲方回收站视图中列出该报表及其原路径。 | 菜单无、回收站有 |
| REQ-LIFE-04 | Event-driven | WHEN 甲方在回收站中对一份报表执行「还原」且原父节点仍存在，系统 SHALL 将其甲方生命周期恢复为 `NORMAL` 并挂载回原父节点。 | 回到原位 |
| REQ-LIFE-05 | Unwanted | IF 甲方执行「还原」时原父节点已被删除，THEN 系统 SHALL 将该报表挂载到甲方标签树根路径，并 SHALL 向甲方提示「原目录已不存在，已还原至根目录」。 | 不丢报表，有提示 |
| REQ-LIFE-06 | Event-driven | WHEN 甲方在其回收站中对一份或多份报表执行「清空」，系统 SHALL 将这些报表的甲方生命周期置为 `PURGED`，并记录清空时间。 | 支持单选与批量 |
| REQ-LIFE-07 | State-driven | WHILE 报表的甲方生命周期为 `PURGED`，系统 SHALL 使该报表对甲方完全不可见（左侧菜单、目录列表、搜索结果、回收站均不出现），且 SHALL 保留报表记录本身。 | 甲方四个入口均无该报表 |
| REQ-LIFE-08 | State-driven | WHILE 报表的甲方生命周期为 `PURGED`，系统 SHALL 使该报表对开发者仍然可见，并 SHALL 在开发者视图中为其展示「甲方已不可见」标识。 | 开发者可见 + 徽标 |
| REQ-LIFE-09 | Event-driven | WHEN 开发者对一份开发者生命周期为 `NORMAL` 的报表执行「删除」，系统 SHALL 将该报表的开发者生命周期置为 `RECYCLED`，并将其在开发者标签树中的挂载点移动到开发者回收站节点，同时记录原父节点。 | 与甲方侧对称 |
| REQ-LIFE-10 | Event-driven | WHEN 开发者在其回收站中对一份或多份报表执行「清空」，系统 SHALL **物理删除**该报表记录及其全部关联数据（两棵树的挂载点、需求、SQL 版本、运行与导出记录），使该报表对两种角色均不可见。 | 数据库记录与关联行均被清除 |
| REQ-LIFE-11 | Unwanted | IF 开发者执行「清空」时该报表的甲方生命周期为 `NORMAL` 或 `RECYCLED`，THEN 系统 SHALL 在执行前弹出显式二次确认，明确告知「甲方侧将同时永久失去该报表」。 | 二次确认文案含影响面 |
| REQ-LIFE-12 | Ubiquitous | 系统 SHALL 使甲方回收站仅展示甲方生命周期为 `RECYCLED` 的报表，开发者回收站仅展示开发者生命周期为 `RECYCLED` 的报表。 | 两个回收站互不可见 |
| REQ-LIFE-13 | Ubiquitous | 系统 SHALL 保证甲方生命周期的状态变更不修改开发者生命周期，反之亦然；唯一例外为 REQ-LIFE-10 的物理删除。 | 状态变更相互隔离 |
| REQ-LIFE-14 | Unwanted | IF 一份报表的甲方生命周期为 `PURGED` 且开发者生命周期为 `PURGED`，THEN 系统 SHALL 自动执行物理删除以保持数据一致性。 | 无孤儿记录 |
| REQ-LIFE-15 | Optional | WHERE 应用配置了删除宽限期（`purgeGraceDays`，默认 7，取值范围 0~30），系统 SHALL 在开发者清空后延迟至宽限期结束才执行物理删除，且 SHALL 允许在宽限期内撤销；当该值为 `0` 时，系统 SHALL 在二次确认后立即执行物理删除。 | 默认 7 天可撤销；配 0 立即删除（Q-06） |
| REQ-LIFE-16 | Event-driven | WHEN 开发者将一份甲方生命周期为 `PURGED` 的报表执行「恢复甲方可见」，系统 SHALL 将其甲方生命周期置为 `RECYCLED` 并移入甲方回收站，交由甲方自行决定是否还原。 | 开发者可代恢复，但**不直接放回甲方菜单**（Q-05） |

---

## 10. 报表元信息与可见性（META）

> 追溯：P-21、P-22

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-META-01 | Ubiquitous | 系统 SHALL 为每份报表持久保留：全部甲方需求条目（多轮）、全部 SQL 版本、创建时间与创建角色。 | 三个集合均可查询 |
| REQ-META-02 | State-driven | WHILE 角色上下文为 `CLIENT`，系统 SHALL 仅展示该报表中由甲方提交的需求条目及其提交时间。 | 甲方可见自己需求 |
| REQ-META-03 | State-driven | WHILE 角色上下文为 `DEVELOPER`，系统 SHALL 展示该报表的全部需求条目与全部 SQL 版本（含文本、作者、时间、变更前后差异）。 | 开发者可见全量 |
| REQ-META-04 | Optional | WHERE 应用未开启「甲方可见 SQL」开关（`clientCanViewSql = false`，默认），系统 SHALL 在角色上下文为 `CLIENT` 且请求获取报表 SQL 文本时拒绝返回并返回 403。 | 接口层拦截，非前端隐藏（Q-02） |
| REQ-META-05 | Event-driven | WHEN SQL 被新增或修改一次，系统 SHALL 追加一条不可变的 SQL 版本记录（含完整文本、参数定义、作者角色、时间、前版本引用）。 | 版本只增不改 |
| REQ-META-06 | Ubiquitous | 系统 SHALL 在报表详情中展示「当前生效 SQL 版本」与「历史版本数量」，且 SHALL 使历史版本只读。 | 只读历史 |
| REQ-META-07 | Optional | WHERE 应用开启了「甲方可见 SQL」开关，系统 SHALL 允许 `CLIENT` 只读查看**当前生效** SQL 文本，且 SHALL 继续对历史版本返回 403。 | 开关开启后甲方可见当前版，历史仍不可见 |

---

## 11. 安全（SEC）— 开发者编辑 SQL 的防护

> 追溯：P-14、A-02、A-06、A-07、A-08

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-SEC-01 | Ubiquitous | 系统 SHALL 仅允许执行单条只读查询语句：语句须以 `SELECT` 或 `WITH` 开头，且其最终输出语句为 `SELECT`。 | 其他语句一律拒绝 |
| REQ-SEC-02 | Unwanted | IF 提交的 SQL 命中以下任一特征——包含 `INSERT`/`UPDATE`/`DELETE`/`REPLACE`/`MERGE`/`CREATE`/`ALTER`/`DROP`/`TRUNCATE`/`GRANT`/`REVOKE`/`SET`/`CALL`/`LOAD_FILE`/`INTO OUTFILE`/`INTO DUMPFILE`/`SLEEP`/`BENCHMARK`、出现语句分隔符堆叠、或访问未授权的系统库——THEN 系统 SHALL 拒绝执行并返回明确的拒绝原因与命中规则编号。 | 规则可编号、可审计 |
| REQ-SEC-03 | Ubiquitous | 系统 SHALL 对每条待执行 SQL 强制注入最大返回行数限制（默认 50,000）与执行超时（默认 30,000 毫秒），该限制 SHALL 优先于 SQL 中自带的所有 LIMIT 值。 | 注入后即便 SQL 写 `LIMIT 1000000` 仍受限 |
| REQ-SEC-04 | Ubiquitous | 系统 SHALL 在只读事务中执行所有业务查询，并在会话级设置只读属性。 | 数据库侧二次兜底 |
| REQ-SEC-05 | Ubiquitous | 系统 SHALL 使用只读账号建立所有数据源连接，且 SHALL 在连接建立后校验会话权限不含写权限。 | 连接建立即校验 |
| REQ-SEC-06 | Event-driven | WHEN 任意 SQL 被执行，系统 SHALL 写入一条审计日志，记录：应用、角色、clientKey、报表 ID（可空）、完整 SQL 文本、开始时间、耗时、返回行数、执行结果（成功/失败/拒绝）与来源类型（预览/导出/保存/开发者调试）。 | 审计不可缺失 |
| REQ-SEC-07 | Ubiquitous | 系统 SHALL 对「应用」维度实施 SQL 执行并发上限（默认 5）与单 clientKey 频率限制（默认 30 次/分钟）。 | 超限返回 429 |
| REQ-SEC-08 | Ubiquitous | 系统 SHALL **强制以参数绑定方式执行**所有 SQL：用户与提示词产生的可变值一律以预编译占位符传入，系统 SHALL 不将任何外部输入拼接进 SQL 文本。 | 执行层只接受「模板 + 参数值」（Q-03 / REQ-PARAM-05） |
| REQ-SEC-09 | Optional | WHERE 数据源配置了敏感列策略，系统 SHALL 对命中的列在返回前执行脱敏（掩码/哈希），且 SHALL 使脱敏对导出文件同样生效。 | 预览与导出一致脱敏 |
| REQ-SEC-10 | Unwanted | IF 本平台以无登录模式部署于公网或非可信网络，THEN 系统 SHALL 要求前置网关至少提供一种访问控制：SSO、IP 白名单或访问令牌。 | 部署检查清单项 |
| REQ-SEC-11 | Ubiquitous | 系统 SHALL 对所有用户可控输入在服务端执行参数校验与输出编码，并 SHALL 对返回前端的报表名称、目录名称等字段执行 HTML 转义。 | 无存储型 XSS |
| REQ-SEC-12 | Ubiquitous | 系统 SHALL 使审计报告与导出行为可追溯至 clientKey 层级，且 SHALL 保留审计日志不少于 180 天。 | 留存策略 |

---

## 12. 非功能需求（NFR）

| ID | 句式 | EARS 需求陈述 | 验收要点 |
|---|---|---|---|
| REQ-NFR-01 | Ubiquitous | 系统 SHALL 使报表列表页首屏渲染时间在 2 秒内完成（网络正常、报表数 ≤ 500）。 | 性能压测 |
| REQ-NFR-02 | Ubiquitous | 系统 SHALL 使预览接口在数据量 ≤ 200 行时的 P95 响应时间不超过 3 秒（不含数据库执行时间）。 | 监控指标 |
| REQ-NFR-03 | Ubiquitous | 系统 SHALL 使开发者保存 SQL 后，甲方刷新可见新结果的端到端延迟不超过 5 秒。 | 「实时」的可验证定义 |
| REQ-NFR-04 | State-driven | WHILE 平台元数据库不可用，系统 SHALL 阻断所有写操作并对读操作返回明确降级提示，且 SHALL 不执行任何业务 SQL。 | 降级不越权 |
| REQ-NFR-05 | Ubiquitous | 系统 SHALL 对平台元数据库执行每日备份，保留不少于 30 天。 | 备份策略 |
| REQ-NFR-06 | Ubiquitous | 系统 SHALL 使所有接口错误返回统一结构（错误码、消息、traceId），且 SHALL 不在错误消息中回显堆栈与连接信息。 | 错误脱敏 |

---

## 13. 关键验收场景（Acceptance Scenarios）

> 以 Given / When / Then 描述端到端可测场景。

### AC-1 主路径：提示词 → 预览 → 临时导出（覆盖 80% 场景）
- **Given** 甲方已打开某应用且已存在可用数据源
- **When** 甲方输入「统计上月各门店销售额」并点击生成
- **Then** 系统返回一条通过安全校验的候选 SQL 与 200 行以内预览结果
- **When** 甲方确认预览并选择「仅导出」
- **Then** 系统生成 xlsx 文件并下载，且报表列表中报表数量不变，审计日志新增 1 条 `source=export` 记录

### AC-2 主路径分叉：保存为常用报表
- **Given** 甲方已确认预览结果
- **When** 甲方选择「保存为常用报表」并填写名称「月度门店销售」
- **Then** 甲方标签树与开发者标签树的根路径下同时出现该报表，两条生命周期均为 `NORMAL`

### AC-3 协作降级：提示词失败 → 开发者改 SQL → 甲方确认
- **Given** 甲方连续 2 次生成 SQL 均执行失败
- **When** 甲方点击「求助开发者」并补充说明
- **Then** 开发者需求收件箱出现一条「待处理」需求，含原始提示词与失败 SQL
- **When** 开发者修改 SQL 并保存、标记「已完成」
- **Then** 甲方刷新页面立即看到新结果，需求状态为「待甲方确认」
- **When** 甲方点击「确认通过」
- **Then** 需求状态置为「已确认」，SQL 版本数为 2

### AC-4 甲方删除 → 还原
- **Given** 报表 R 位于甲方目录「销售/月度」下，状态 `NORMAL`
- **When** 甲方删除 R
- **Then** R 的甲方生命周期为 `RECYCLED`，左侧菜单「销售/月度」下不再显示 R，甲方回收站中出现 R 且标注原路径「销售/月度」，开发者侧 R 仍为 `NORMAL` 且位置不变
- **When** 甲方在回收站点击「还原」
- **Then** R 回到「销售/月度」，甲方生命周期恢复 `NORMAL`

### AC-5 甲方清空 → 甲方不可见、开发者仍可见
- **Given** 报表 R 甲方生命周期为 `RECYCLED`
- **When** 甲方在回收站点击「清空」
- **Then** 甲方生命周期为 `PURGED`；甲方菜单、列表、搜索、回收站均无 R；开发者标签树中 R 仍存在并带「甲方已不可见」标识；数据库记录仍在

### AC-6 开发者清空 → 物理删除
- **Given** 报表 R 开发者生命周期为 `RECYCLED`
- **When** 开发者在回收站点击「清空」并通过二次确认
- **Then** R 的记录及其挂载点、需求、SQL 版本、运行记录被物理删除；甲方侧无论如何均不可见

### AC-7 危险 SQL 被拦截
- **Given** 开发者在 SQL 编辑框中提交 `SELECT * FROM orders; DROP TABLE orders;`
- **When** 开发者点击执行
- **Then** 系统拒绝执行，返回命中规则编号与原因，审计日志新增一条 `result=rejected` 记录，`orders` 表未被删除

### AC-8 甲方 SQL 可见性开关（默认关闭）
- **Given** 报表 R 存在 SQL，应用配置 `clientCanViewSql = false`
- **When** 甲方直接调用报表详情接口并请求 SQL 字段
- **Then** 接口返回 403，响应体中不含任何 SQL 文本
- **When** 开发者将 `clientCanViewSql` 改为 `true`
- **Then** 甲方可见当前生效 SQL 文本，请求历史版本仍返回 403

### AC-9 参数化报表的填写与执行
- **Given** 报表 R 的 SQL 含 `{{start_date}}` 与 `{{region}}`，其中 `region` 必填
- **When** 甲方打开 R 且未填写 `region`
- **Then** 执行按钮为禁用状态
- **When** 甲方填写 `start_date = 上月`（快捷预设）与 `region = 华东` 并执行
- **Then** 系统以参数绑定方式执行，审计日志记录「SQL 模板」与「参数值」两部分；将 `region` 填入 `华东'; DROP TABLE orders; --` 时系统按字符串值处理，`orders` 表不被删除

### AC-10 导出历史与过期重跑
- **Given** 甲方在 3 天前执行过一次临时导出
- **When** 甲方打开「我的导出历史」
- **Then** 列表中存在该任务且标记为「已过期」（文件 TTL 24h 已过）
- **When** 甲方点击「重新导出」
- **Then** 系统基于原 SQL 与参数重新执行并生成新的可下载文件

---

## 14. 需求统计与覆盖检查

| 模块 | 需求数 | 覆盖的 P- / Q- 项 |
|---|---|---|
| ACC 应用与访问 | 13 | P-12, P-13；Q-08 |
| DS 数据源 | 8 | P-10, P-11 |
| GEN 提示词生成与预览 | 10 | P-02, P-03；Q-07 |
| EXP 导出 | 9 | P-03, P-04, P-05；Q-04, Q-09 |
| **PARAM 报表参数** | **9** | **Q-03** |
| SAVE 常用报表 | 6 | P-04, P-16, P-21 |
| COL 需求协作 | 8 | P-06, P-07, P-21, P-22 |
| TAG 标签管理器 | 9 | P-15, P-16, P-20 |
| LIFE 生命周期 | 16 | P-08, P-17, P-18, P-19, P-20；Q-05, Q-06 |
| META 元信息 | 7 | P-21, P-22；Q-02 |
| SEC 安全 | 12 | P-14；Q-01, Q-03 |
| NFR 非功能 | 6 | — |
| **合计** | **113** | P-01 ~ P-22 全覆盖；Q-01 ~ Q-10 已收敛 |
