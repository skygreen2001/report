// 应用服务（doc §5、§17.1）。平台根应用创建/停用；普通应用创建后初始化两棵树（REQ-ACC-10/11/13）。
import { pGet, pQuery, pRun } from '../db/platform';
import { initClientTree } from './tagTree';
import { ensureDefaultWorkspace } from './devWorkspace';
import { HttpError } from '../errors';
import { parseSettings, invalidateAppCache } from '../context';
import type { ApplicationRow, AppSettings, RoleContext } from '@/lib/types';
import crypto from 'node:crypto';

export interface CreateAppInput {
  name: string;
  pathPrefix: string;
  host?: string;
  settings?: Partial<AppSettings>;
}

export async function createApplication(input: CreateAppInput): Promise<string> {
  const id = crypto.randomUUID();
  const settings: AppSettings = {
    clientCanViewSql: false,
    maxRows: Number(process.env.DEFAULT_MAX_ROWS ?? 200),
    timeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS ?? 15000),
    exportFileTtlHours: 24,
    purgeGraceDays: 7,
    embedMode: false,
    llm: { endpoint: process.env.LLM_BASE_URL ?? '', model: process.env.LLM_MODEL ?? 'deepseek-chat' },
    defaultDs: null,
    ...(input.settings ?? {}),
  };
  await pRun(
    `INSERT INTO application (id,name,host,path_prefix,status,is_platform_root,settings_json)
     VALUES (?,?,?,?,?,?,?)`,
    [id, input.name, input.host ?? '', input.pathPrefix, 'ACTIVE', 0, JSON.stringify(settings)],
  );
  // 甲方汇总视图一棵树（REQ-ACC-11）；再建一个默认工作区（主开发者空间，原单开发者体验）。
  await initClientTree(id);
  await ensureDefaultWorkspace(id);
  return id;
}

// 仅平台根应用可用（REQ-ACC-10）。停用根应用被拒（REQ-ACC-13）。
export async function disableApplication(ctx: RoleContext, id: string): Promise<void> {
  if (!ctx.app.is_platform_root) throw new HttpError(403, 'NOT_PLATFORM_ROOT');
  const app = await pGet<ApplicationRow>('SELECT * FROM application WHERE id=?', [id]);
  if (!app) throw new HttpError(404, 'APP_NOT_FOUND');
  if (app.is_platform_root) throw new HttpError(400, 'CANNOT_DISABLE_ROOT'); // REQ-ACC-13
  await pRun("UPDATE application SET status='DISABLED' WHERE id=?", [id]);
  invalidateAppCache(app.host, app.path_prefix); // 即时失效缓存（REQ-ACC-07）
}

// 重新启用（停用可逆，否则误点一次只能改库）
export async function enableApplication(ctx: RoleContext, id: string): Promise<void> {
  if (!ctx.app.is_platform_root) throw new HttpError(403, 'NOT_PLATFORM_ROOT');
  const app = await pGet<ApplicationRow>('SELECT * FROM application WHERE id=?', [id]);
  if (!app) throw new HttpError(404, 'APP_NOT_FOUND');
  await pRun("UPDATE application SET status='ACTIVE' WHERE id=?", [id]);
  invalidateAppCache(app.host, app.path_prefix);
}

export async function listApplications(): Promise<ApplicationRow[]> {
  return pQuery<ApplicationRow>('SELECT * FROM application ORDER BY is_platform_root DESC, created_at');
}

// 初始化平台根应用（首次部署 seed 调用）
export async function ensurePlatformRoot(): Promise<string> {
  const existing = await pGet<ApplicationRow>('SELECT * FROM application WHERE is_platform_root=1');
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const settings: AppSettings = {
    clientCanViewSql: false,
    maxRows: Number(process.env.DEFAULT_MAX_ROWS ?? 200),
    timeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS ?? 15000),
    exportFileTtlHours: 24,
    purgeGraceDays: 7,
    embedMode: false,
    llm: { endpoint: process.env.LLM_BASE_URL ?? '', model: process.env.LLM_MODEL ?? 'deepseek-chat' },
    defaultDs: null,
  };
  await pRun(
    `INSERT INTO application (id,name,host,path_prefix,status,is_platform_root,settings_json)
     VALUES (?,?,?,?,?,?,?)`,
    [id, '平台根', '', 'platform', 'ACTIVE', 1, JSON.stringify(settings)],
  );
  await initClientTree(id);
  await ensureDefaultWorkspace(id);
  return id;
}

// 改应用级设置（开发者用：目前承载 clientCanViewSql 等）。合并后写回 settings_json，并即时失效缓存
// （否则开发者切换开关后，甲方侧要等 60s 缓存 TTL 才更新）。仅接受已知字段，未识别的忽略。
export async function updateAppSettings(appId: string, patch: Partial<AppSettings>): Promise<AppSettings> {
  const row = await pGet<ApplicationRow>('SELECT id, host, path_prefix, settings_json FROM application WHERE id=?', [appId]);
  if (!row) throw new HttpError(404, 'APP_NOT_FOUND');
  const cur = parseSettings(row.settings_json);
  const next: AppSettings = { ...cur };
  if (typeof patch.clientCanViewSql === 'boolean') next.clientCanViewSql = patch.clientCanViewSql;
  // 其他未来设置字段在此处逐个认领即可，结构保持不变
  await pRun('UPDATE application SET settings_json=? WHERE id=?', [JSON.stringify(next), appId]);
  invalidateAppCache(row.host, row.path_prefix);
  return next;
}
