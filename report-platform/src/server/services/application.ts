// 应用服务（doc §5、§17.1）。平台根应用创建/停用；普通应用创建后初始化两棵树（REQ-ACC-10/11/13）。
import { pGet, pQuery, pRun } from '../db/platform';
import { initTrees } from './tagTree';
import { HttpError } from '../errors';
import type { ApplicationRow, AppSettings, RoleContext } from '@/lib/types';
import crypto from 'node:crypto';
import { invalidateAppCache } from '../context';

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
  await initTrees(id); // 初始化两棵标签树（REQ-ACC-11）
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
  await initTrees(id);
  return id;
}
