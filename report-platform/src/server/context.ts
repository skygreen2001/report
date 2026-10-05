// RoleContext 解析（doc §2.3）。每次请求重算，绝不信任前端传入角色。
import { pGet } from './db/platform';
import { cacheGet, cacheSet, cacheDeleteBySuffix } from './cache';
import { HttpError } from './errors';
import type { ApplicationRow, AppSettings, Role, RoleContext } from '@/lib/types';

const APP_CACHE_TTL = 60_000; // REQ-ACC-07：停用后最多 60s 生效

export function defaultSettings(): AppSettings {
  return {
    clientCanViewSql: false,
    maxRows: Number(process.env.DEFAULT_MAX_ROWS ?? 200),
    timeoutMs: Number(process.env.DEFAULT_TIMEOUT_MS ?? 15_000),
    exportFileTtlHours: 24,
    purgeGraceDays: 7,
    embedMode: false,
    llm: {
      endpoint: process.env.LLM_BASE_URL ?? '',
      model: process.env.LLM_MODEL ?? 'deepseek-chat',
    },
    defaultDs: null,
  };
}

export function parseSettings(json: string | null): AppSettings {
  const base = defaultSettings();
  if (!json) return base;
  try {
    const parsed = JSON.parse(json);
    return { ...base, ...parsed, llm: { ...base.llm, ...(parsed.llm ?? {}) } };
  } catch {
    return base;
  }
}

async function getApplicationByHostPath(host: string, pathPrefix: string): Promise<ApplicationRow | undefined> {
  const key = `app:${host}#${pathPrefix}`;
  const cached = cacheGet<ApplicationRow>(key);
  if (cached) return cached;
  // 精确 host 优先，host 为空表示"任意 host 均可"（单机/内网部署常见）；
  // 这样 127.0.0.1 / localhost / 自定义域名都能命中同一应用。
  const row = await pGet<ApplicationRow>(
    `SELECT * FROM application WHERE path_prefix=? AND (host=? OR host='')
     ORDER BY host DESC LIMIT 1`,
    [pathPrefix, host],
  );
  if (row) cacheSet(key, row, APP_CACHE_TTL);
  return row;
}

// 供停用/创建/改设置后即时失效缓存。
// 注意：写入用的是请求 host，库里可能是 host=''（通配），只删精确 key 会漏，故按 path_prefix 后缀全清。
export function invalidateAppCache(host: string, pathPrefix: string) {
  cacheDeleteBySuffix(`#${pathPrefix}`);
}

export function readClientKey(req: Request): string {
  const cookie = req.headers.get('cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)clientKey=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  return 'anonymous';
}

// 解析请求 → RoleContext。host + path 推导应用与角色（doc §2.3、REQ-ACC-03/04/05）。
export async function resolveContext(req: Request): Promise<RoleContext> {
  const url = new URL(req.url);
  const host = req.headers.get('host') ?? '';
  const seg = url.pathname.split('/').filter(Boolean);

  // 中间件 rewrite 后路径会变成 /tenant/{appPath}/{c|d}/... ，
  // 优先用中间件写入的请求头；直连 /tenant/... 或 /{appPath}/{c|d}/... 时按路径兜底。
  const hApp = req.headers.get('x-app-path');
  const hRole = req.headers.get('x-role');
  const appPath = hApp ?? (seg[0] === 'tenant' ? seg[1] : seg[0]) ?? '';
  const roleSeg = hRole ?? (seg[0] === 'tenant' ? seg[2] : seg[1]) ?? '';
  if (roleSeg !== 'c' && roleSeg !== 'd') throw new HttpError(404, 'APP_NOT_FOUND');

  // 平台根应用按固定 path_prefix 解析；普通应用由 host+path_prefix 定位
  const app = await getApplicationByHostPath(host, appPath);
  if (!app || app.status !== 'ACTIVE') {
    // 不泄露应用名/报表名/库表名（REQ-ACC-07、§17.1）
    throw new HttpError(404, 'APP_NOT_FOUND');
  }

  return {
    appId: app.id,
    role: (roleSeg === 'd' ? 'DEVELOPER' : 'CLIENT') as Role,
    clientKey: readClientKey(req),
    settings: parseSettings(app.settings_json),
    app,
  };
}

// 平台根应用上下文（应用管理入口，仅根应用内可用，REQ-ACC-10/13）
export async function resolvePlatformRoot(req: Request): Promise<RoleContext> {
  const ctx = await resolveContext(req);
  if (!ctx.app.is_platform_root) throw new HttpError(403, 'NOT_PLATFORM_ROOT');
  if (ctx.role !== 'DEVELOPER') throw new HttpError(403, 'FORBIDDEN');
  return ctx;
}
