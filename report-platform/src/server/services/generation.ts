// NL2SQL 生成（doc §5、§17.7）。出网仅含元数据+提示词+当前模板；失败降级手工模式(REQ-GEN-09)。
import OpenAI from 'openai';
import { loadDataSource, getCatalog, listDataSources } from './datasource';
import { resolveProvider } from './llm';
import { presetOf } from '@/lib/llm-presets';
import { auditAction } from './audit';
import { HttpError } from '../errors';
import type { RoleContext, DataSourceRow } from '@/lib/types';

export interface GenerateInput {
  prompt: string;
  dataSourceId?: string; // 兼容：只用一个数据源
  dataSourceIds?: string[]; // 多个数据源：跨所有已连接的库生成（默认即全部 ACTIVE 源）
  currentSql?: string; // 协作：开发者在已有 SQL 基础上改
  providerId?: string | null; // 指定模型；不传用应用默认
}

export interface GenerateResult {
  mode: 'llm' | 'manual';
  sql: string | null;
  understanding?: string; // 理解说明 + 用到的表字段（不展示 SQL 全文给甲方）
  tables?: string[];
  reason?: string; // 降级原因
  noModel?: boolean; // true=本角色未配置任何模型（应把需求交给开发者）；false=模型存在但生成失败
  // 每个能匹配需求的数据源各生成一条 SQL，由用户选用哪个库的 SQL（表名跨库不同时 SQL 也不同）
  dataSourceId?: string | null;
  results?: { dataSourceId: string; name: string; databaseName: string; sql: string; tables: string[] }[];
  ambiguous?: boolean;
  stopped?: boolean; // true=被用户「停止生成」中断（模型调用已 abort，省算力）
}

const SYS_PROMPT = '你是企业报表平台的 SQL 生成助手。只输出一条 MySQL SELECT（或 WITH...SELECT）只读查询，禁止任何写操作、禁止系统库、禁止 INTO OUTFILE、禁止 SLEEP 等危险函数。参数用 {{name}} 占位（仅值位置）。只返回 SQL，不要解释。';

// 出网内容仅含元数据（表名/列名/注释）+ 用户提示词，不含任何业务数据（doc §17.7）
function buildUserPrompt(prompt: string, catalog: any[], currentSql?: string): string {
  const meta = catalog
    .map((t) => `表 ${t.table}: ${(t.columns ?? []).map((c: any) => c.column_name).join(', ')}`)
    .join('\n');
  return `可用元数据：\n${meta}\n\n用户需求：${prompt}${currentSql ? `\n\n当前 SQL（在此基础上修改）：\n${currentSql}` : ''}`;
}

function buildClient(endpoint: string, apiKey: string) {
  return new OpenAI({ apiKey, baseURL: endpoint, timeout: 20_000 });
}

// 粗提取 SQL 里用到的表名（FROM / JOIN 后的标识符），用于判断该 SQL 能落在哪些库上
function extractTables(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:from|join)\s+`?([A-Za-z0-9_$]+)`?(?:\s*\.\s*`?([A-Za-z0-9_$]+)`?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const t = m[2] || m[1];
    if (t) out.add(t);
  }
  return [...out];
}

// 表名编辑距离（用于修正模型幻觉的表名：把不存在的表名映射到 catalog 里最接近的真实表）
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}
// 按 _ 分词后共享的 token 总长（排除 mp 等公共前缀），用于编辑距离相同时优先选语义更接近的表
function sharedTokenLen(a: string, b: string): number {
  const tb = new Set(b.split('_'));
  let n = 0;
  for (const x of a.split('_')) if (tb.has(x) && x !== 'mp') n += x.length;
  return n;
}

// 参与本次生成的数据源：显式指定多个 > 单个 > 本工作区全部 ACTIVE 数据源。
// 开发者只在自己工作区的库里生成；甲方（汇总方）可跨本应用所有开发者的库生成。
async function resolveTargets(ctx: RoleContext, input: GenerateInput): Promise<DataSourceRow[]> {
  let ids = (input.dataSourceIds ?? []).filter(Boolean);
  if (!ids.length && input.dataSourceId) ids = [input.dataSourceId];
  if (!ids.length) {
    const all = await listDataSources(ctx);
    ids = all.filter((d) => d.status === 'ACTIVE').map((d) => d.id);
  }
  if (!ids.length) throw new HttpError(400, 'NO_DATA_SOURCE');
  // 只连 ACTIVE 源：停用的库可能已不可达，参与生成会拖垮整次请求
  const dss = (await Promise.all(ids.map((id) => loadDataSource(id)))).filter((ds) => ds.status === 'ACTIVE');
  if (!dss.length) throw new HttpError(400, 'NO_DATA_SOURCE');
  // 越权防护：数据源必须属于当前应用
  for (const ds of dss) if (ds.app_id !== ctx.appId) throw new HttpError(403, 'FORBIDDEN');
  return dss;
}

// ── 「停止生成」：真正中断到模型的 HTTP 请求（不只是前端不等了） ──
// 每个生成任务持有一个 AbortController，signal 会透传给 OpenAI 客户端，
// abort 后到模型的请求立即断开 → 模型不再继续推理，省算力。
type GenTask = { ctrl: AbortController; appId: string; role: string };
const g = globalThis as any;
g.__genTasks ??= new Map<string, GenTask>();
const genTasks: Map<string, GenTask> = g.__genTasks; // 挂 globalThis：dev 热重载不会丢

export function registerGenTask(taskId: string, appId: string, role: string): AbortController {
  const ctrl = new AbortController();
  genTasks.set(taskId, { ctrl, appId, role });
  return ctrl;
}
export function unregisterGenTask(taskId: string) { genTasks.delete(taskId); }
// 只停「本应用 + 本角色」的任务，防止跨租户/跨角色误停别人的生成
export function stopGenTask(taskId: string, ctx: RoleContext): boolean {
  const t = genTasks.get(taskId);
  if (!t) return false;
  if (t.appId !== ctx.appId || t.role !== ctx.role) return false;
  t.ctrl.abort();
  genTasks.delete(taskId);
  return true;
}

export interface GenerateOptions {
  taskId?: string; // 前端生成，供取消端点定位任务
  requestSignal?: AbortSignal; // 客户端断开（关页面/abort fetch）时自动中断，同样省算力
}

export async function generateSql(ctx: RoleContext, input: GenerateInput, opts?: GenerateOptions): Promise<GenerateResult> {
  const ctrl = opts?.taskId ? registerGenTask(opts.taskId, ctx.appId, ctx.role) : new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts?.requestSignal) {
    if (opts.requestSignal.aborted) ctrl.abort();
    else opts.requestSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await generateSqlInner(ctx, input, ctrl.signal);
  } finally {
    if (opts?.taskId) unregisterGenTask(opts.taskId);
    if (opts?.requestSignal) opts.requestSignal.removeEventListener('abort', onAbort);
  }
}

async function generateSqlInner(ctx: RoleContext, input: GenerateInput, signal?: AbortSignal): Promise<GenerateResult> {
  const dss = await resolveTargets(ctx, input);
  // 模型优先级：本次指定 > 应用默认（llm_provider）> 应用 settings.llm > 环境变量
  const p = await resolveProvider(ctx, input.providerId);

  // 本角色一个模型都没配：降级为手工模式，并把需求交给开发者
  if (!p) {
    const hint = ctx.role === 'CLIENT'
      ? '未配置可用模型（请到「模型配置」中添加你自己的模型）'
      : '未配置可用模型（开发者端 → 模型配置）';
    return { mode: 'manual', sql: null, reason: hint, noModel: true };
  }
  // 缺核心连接信息（只可能是用户手改过，正常新增必带）
  if (!p.endpoint || !p.model) {
    return { mode: 'manual', sql: null, reason: '模型缺少接口地址或模型名（请到「模型配置」补全）', noModel: false };
  }
  // 本地/自建模型（ollama/vllm/xinference/lmstudio）与自定义 OpenAI 兼容服务允许不填密钥；
  // 云端厂商（deepseek/qwen 等）必须有 key，否则明确提示缺 key，而不是误判「没模型」。
  const keyOptional = presetOf(p.vendor)?.local === true || p.vendor === 'custom';
  if (!keyOptional && !p.apiKey) {
    return { mode: 'manual', sql: null, reason: '该模型缺少 API Key（请到「模型配置」补全密钥）', noModel: false };
  }
  const endpoint = p.endpoint;
  const apiKey = p.apiKey || 'EMPTY'; // 本地模型无需 key，与 testProvider 一致
  const model = p.model;

  // 对每个数据源并行生成一条 SQL（每库独立元数据）。
  // 不同库的"类似表"表名可能不同（如 biz_demo.orders vs mftgshop.mp_user_order），SQL 也不同，
  // 所以针对每个库各生成一条，校验用到的表确实在该库后，交由用户选用哪个库的 SQL。
  type Cand = { dataSourceId: string; name: string; databaseName: string; sql: string; tables: string[] };
  const tasks = dss.map(async (ds): Promise<Cand | null> => {
    const tables = await getCatalog(ds);
    if (!tables.length) return null;
    if (signal?.aborted) return null; // 已停止：不再发起新的模型调用
    try {
      const client = buildClient(endpoint, apiKey);
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SYS_PROMPT },
          { role: 'user', content: buildUserPrompt(input.prompt, tables, input.currentSql) },
        ],
        temperature: 0,
      }, { signal }); // 透传中断信号：abort 后到模型的请求立即断开，模型停止推理
      let sql = completion.choices[0]?.message?.content?.trim() ?? '';
      sql = sql.replace(/^```(?:sql)?/i, '').replace(/```$/i, '').trim();
      // 模型偶尔幻觉表名（如把 mp_user_order 记成 mp_core_order）：
      // 用 catalog 里共享 token 最多、编辑距离最近的真实表名修正，再重校验；修正不了的才剔除。
      let fixedSql = sql;
      let used = extractTables(fixedSql);
      const known = new Set(tables.map((t: any) => t.table));
      if (used.length && !used.every((t) => known.has(t))) {
        const tried = used.map((t) => {
          if (known.has(t)) return t;
          let best = '', bs = -1, bd = Infinity;
          for (const k of known) {
            const s = sharedTokenLen(t, k);
            const d = levenshtein(t, k);
            if (s > bs || (s === bs && d < bd)) { bs = s; bd = d; best = k; }
          }
          const thr = Math.max(3, Math.floor(t.length / 2));
          return bs >= 3 && bd <= thr ? best : null;
        });
        if (tried.every((x) => x)) {
          tried.forEach((good, i) => { if (good && good !== used[i]) fixedSql = fixedSql.replace(new RegExp('\\b' + used[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), good); });
          used = extractTables(fixedSql);
        }
      }
      if (!fixedSql || !used.length || !used.every((t) => known.has(t))) return null;
      return { dataSourceId: ds.id, name: ds.name, databaseName: ds.database_name, sql: fixedSql, tables: used };
    } catch {
      return null;
    }
  });
  const results = (await Promise.all(tasks)).filter((x): x is Cand => x !== null);

  // 被用户停止：不降级成「生成失败」，明确返回 stopped（前端据此提示「已停止」）
  if (signal?.aborted) {
    await auditAction(ctx, { action: 'GEN_STOP', targetType: 'data_source', targetId: dss[0].id, detail: { prompt: input.prompt, provider: p.id || 'env' } });
    return { mode: 'manual', sql: null, reason: '生成已被用户停止', stopped: true };
  }

  if (!results.length) {
    // 全部库都生成失败 → 降级手工模式
    await auditAction(ctx, { action: 'GEN_DEGRADE', targetType: 'data_source', targetId: dss[0].id, detail: { error: '所有数据源生成均失败或无匹配表' } });
    return { mode: 'manual', sql: null, reason: '所有已连接的数据库均未能生成有效 SQL，请检查模型配置或手写 SQL' };
  }

  const first = results[0];
  await auditAction(ctx, { action: 'GEN_LLM', targetType: 'data_source', targetId: first.dataSourceId, detail: { prompt: input.prompt, model, provider: p.id || 'env', candidates: results.length } });
  return {
    mode: 'llm',
    sql: first.sql,
    understanding: results.length > 1
      ? `已针对 ${results.length} 个数据源各生成一条 SQL（不同库的表名/字段可能不同，SQL 也不同），请选择使用哪个库的 SQL`
      : `已根据元数据生成查询（模型：${p.name} / ${model}）`,
    tables: first.tables,
    dataSourceId: first.dataSourceId,
    results,
    ambiguous: results.length > 1,
  };
}
