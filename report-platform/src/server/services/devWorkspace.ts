// 开发者工作区服务：每个使用者 = 一个平等的工作区，身份由「浏览器」承载。
//
// 身份怎么来（免登录、无感、菜单零改动）：
//   中间件在首次访问时生成一个随机串写进浏览器 Cookie；带 ?ws=<key> 的链接可把身份搬到别的设备。
//   身份本身不含任何敏感信息，真正的配置仍存在服务器，只按它做归属隔离。
//
// 可见性规则（关键）：
//   /d 开发者视图 → 只看到「自己这个身份」的数据源 / 模型 / 目录（别人看不见，需要自己配）。
//   /c 甲方视图   → 汇总「所有身份」产出的报表（人人可见，且能正常运行，因为数据源凭据在服务器）。
import { pGet, pQuery, pRun } from '../db/platform';
import { initDevTree } from './tagTree';
import { HttpError } from '../errors';
import crypto from 'node:crypto';
import type { DevWorkspaceRow } from '@/lib/types';

const KEY_RE = /^[0-9a-f]{18}$/; // 我们生成的 18 位十六进制 key；非此格式视为非法 → 404

function newKey(): string {
  return crypto.randomBytes(9).toString('hex');
}

// 应用默认工作区：建应用时建的那一套。首次有人访问时会被「认领」（claimed=1）。
// 无人认领前它是公开的候选，这样存量配置不会因升级而丢失。
export async function getDefaultWorkspace(appId: string): Promise<DevWorkspaceRow> {
  let row = await pGet<DevWorkspaceRow>(
    "SELECT * FROM dev_workspace WHERE app_id=? ORDER BY created_at LIMIT 1", [appId],
  );
  if (!row) {
    const id = crypto.randomUUID();
    await pRun(
      `INSERT INTO dev_workspace (id,app_id,ws_key,name,kind,status) VALUES (?,?,?,?,'DEVELOPER','ACTIVE')`,
      [id, appId, newKey(), '主开发者'],
    );
    row = (await pGet<DevWorkspaceRow>('SELECT * FROM dev_workspace WHERE id=?', [id]))!;
    await initDevTree(appId, id);
  }
  return row;
}

// 应用创建时建一个默认工作区即可（不再有 OWNER / 多层级管理）。
export async function ensureDefaultWorkspace(appId: string): Promise<DevWorkspaceRow> {
  return getDefaultWorkspace(appId);
}

// 请求 → 工作区。
//   wsKey 由中间件保证：URL 带 ?ws= 优先，其次浏览器 Cookie，都没有就现生成一个写进 Cookie。
//   因此「每个浏览器天然一套私密配置」，无需登录、无需发链接、菜单零改动。
//
//   1) key 已存在  → 直接返回该工作区（同一个人换页面仍是同一套）。
//   2) key 是新的  → 优先「认领」本应用里尚未被认领的工作区（存量迁移过来的那套，保证老配置不丢）；
//                    没有可认领的才新建一个空工作区。
//   3) 非法 key    → 404（防止乱填 key 污染数据库）。
export async function resolveWorkspace(
  appId: string,
  wsKey: string | null,
  generated = false,
): Promise<DevWorkspaceRow> {
  if (!wsKey) return getDefaultWorkspace(appId); // 直连 /tenant/... 绕过中间件时的兜底
  const row = await pGet<DevWorkspaceRow>(
    "SELECT * FROM dev_workspace WHERE app_id=? AND ws_key=? AND status='ACTIVE'", [appId, wsKey],
  );
  if (row) return row;
  if (!KEY_RE.test(wsKey)) {
    throw new HttpError(404, 'WORKSPACE_NOT_FOUND', '工作区不存在或链接无效。');
  }
  // 认领：只有「新浏览器第一次来」才认领尚未归属的工作区（存量配置不会被 ?ws= 链接抢走）
  if (generated) {
    const unclaimed = await pGet<DevWorkspaceRow>(
      'SELECT * FROM dev_workspace WHERE app_id=? AND claimed=0 ORDER BY created_at LIMIT 1', [appId],
    );
    if (unclaimed) {
      await pRun('UPDATE dev_workspace SET ws_key=?, claimed=1 WHERE id=?', [wsKey, unclaimed.id]);
      return (await pGet<DevWorkspaceRow>('SELECT * FROM dev_workspace WHERE id=?', [unclaimed.id]))!;
    }
  }
  const id = crypto.randomUUID();
  await pRun(
    `INSERT INTO dev_workspace (id,app_id,ws_key,name,kind,status,claimed) VALUES (?,?,?,?,'DEVELOPER','ACTIVE',1)`,
    [id, appId, wsKey, '工作区'],
  );
  const created = (await pGet<DevWorkspaceRow>('SELECT * FROM dev_workspace WHERE id=?', [id]))!;
  await initDevTree(appId, id);
  return created;
}
