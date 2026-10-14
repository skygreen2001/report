// 标签树服务（doc §4、§10.2、REQ-TAG-01~07）。
// 目录树隔离粒度：
//   · 甲方（CLIENT）—— 全应用一棵，ws_id IS NULL；
//   · 开发者（DEVELOPER）—— 每个「开发者工作区」各一棵，ws_id = 该工作区。
// 这样 A 开发者看不见 B 开发者的目录结构，甲方也看不见任何开发者的目录树。
import { pGet, pQuery, pRun, platformTx } from '../db/platform';
import { HttpError } from '../errors';
import crypto from 'node:crypto';

const MAX_DEPTH = 5; // REQ-TAG-07

type TreeRole = 'CLIENT' | 'DEVELOPER';

// 开发者侧按工作区过滤；甲方侧固定取 ws_id IS NULL 的那棵
function wsCond(role: TreeRole): string {
  return role === 'CLIENT' ? 'ws_id IS NULL' : 'ws_id = ?';
}
function wsParams(role: TreeRole, wsId: string | null | undefined, base: unknown[]): unknown[] {
  return role === 'CLIENT' ? base : [...base, wsId ?? null];
}

export async function initClientTree(appId: string): Promise<void> {
  for (const [kind, name, sort] of [['ROOT', '根目录', 0], ['RECYCLE_BIN', '回收站', 999]] as const) {
    const existing = await pGet(
      'SELECT id FROM tag_node WHERE app_id=? AND role=? AND ws_id IS NULL AND kind_uniq=?', [appId, 'CLIENT', kind],
    );
    if (!existing) {
      await pRun('INSERT INTO tag_node (id,app_id,role,ws_id,kind,name,kind_uniq,sort) VALUES (?,?,?,NULL,?,?,?,?)',
        [crypto.randomUUID(), appId, 'CLIENT', kind, name, kind, sort]);
    }
  }
}

// 每个开发者工作区一棵自己的目录树
export async function initDevTree(appId: string, wsId: string): Promise<void> {
  for (const [kind, name, sort] of [['ROOT', '根目录', 0], ['RECYCLE_BIN', '回收站', 999]] as const) {
    const existing = await pGet(
      'SELECT id FROM tag_node WHERE app_id=? AND role=? AND ws_id=? AND kind_uniq=?', [appId, 'DEVELOPER', wsId, kind],
    );
    if (!existing) {
      await pRun('INSERT INTO tag_node (id,app_id,role,ws_id,kind,name,kind_uniq,sort) VALUES (?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), appId, 'DEVELOPER', wsId, kind, name, kind, sort]);
    }
  }
}

// 系统节点在建应用/建工作区时就初始化，缺失属于数据异常 —— 直接抛错
export async function getRoot(appId: string, role: TreeRole, wsId?: string | null): Promise<any> {
  const n = await pGet(
    `SELECT * FROM tag_node WHERE app_id=? AND role=? AND ${wsCond(role)} AND kind_uniq='ROOT'`,
    wsParams(role, wsId, [appId, role]),
  );
  if (!n) throw new HttpError(500, 'ROOT_NODE_MISSING');
  return n;
}
export async function getRecycleBin(appId: string, role: TreeRole, wsId?: string | null): Promise<any> {
  const n = await pGet(
    `SELECT * FROM tag_node WHERE app_id=? AND role=? AND ${wsCond(role)} AND kind_uniq='RECYCLE_BIN'`,
    wsParams(role, wsId, [appId, role]),
  );
  if (!n) throw new HttpError(500, 'RECYCLE_BIN_MISSING');
  return n;
}

export async function listNodes(appId: string, role: TreeRole, wsId?: string | null) {
  return pQuery(
    `SELECT * FROM tag_node WHERE app_id=? AND role=? AND ${wsCond(role)} ORDER BY sort, created_at`,
    wsParams(role, wsId, [appId, role]),
  );
}

export async function createNode(
  appId: string, role: TreeRole, wsId: string | null, name: string, parentId: string | null,
): Promise<string> {
  if (parentId) {
    const parent = await pGet(
      `SELECT * FROM tag_node WHERE id=? AND app_id=? AND role=? AND ${wsCond(role)}`,
      wsParams(role, wsId, [parentId, appId, role]),
    );
    if (!parent) throw new HttpError(404, 'NODE_NOT_FOUND');
    if (parent.kind_uniq === 'RECYCLE_BIN') throw new HttpError(400, 'CANNOT_ADD_UNDER_BIN');
    const depth = await depthOf(appId, role, wsId, parentId);
    if (depth >= MAX_DEPTH) throw new HttpError(400, 'MAX_DEPTH_EXCEEDED'); // REQ-TAG-07
  }
  const id = crypto.randomUUID();
  await pRun('INSERT INTO tag_node (id,app_id,role,ws_id,kind,name,parent_id,sort) VALUES (?,?,?,?,\'NORMAL\',?,?,0)',
    [id, appId, role, role === 'CLIENT' ? null : wsId, name, parentId]);
  return id;
}

async function depthOf(appId: string, role: TreeRole, wsId: string | null, nodeId: string): Promise<number> {
  let depth = 1;
  let cur = await pGet(
    `SELECT parent_id FROM tag_node WHERE id=? AND app_id=? AND role=? AND ${wsCond(role)}`,
    wsParams(role, wsId, [nodeId, appId, role]),
  );
  while (cur?.parent_id) {
    depth++;
    cur = await pGet(
      `SELECT parent_id FROM tag_node WHERE id=? AND app_id=? AND role=? AND ${wsCond(role)}`,
      wsParams(role, wsId, [cur.parent_id, appId, role]),
    );
  }
  return depth;
}

export async function renameNode(
  appId: string, role: TreeRole, wsId: string | null, nodeId: string, name: string,
): Promise<void> {
  const node = await pGet(
    `SELECT * FROM tag_node WHERE id=? AND app_id=? AND role=? AND ${wsCond(role)}`,
    wsParams(role, wsId, [nodeId, appId, role]),
  );
  if (!node) throw new HttpError(404, 'NODE_NOT_FOUND');
  if (node.kind_uniq) throw new HttpError(400, 'SYSTEM_NODE_IMMUTABLE'); // REQ-TAG-03
  await pRun('UPDATE tag_node SET name=? WHERE id=?', [name, nodeId]);
}

export async function deleteNode(
  appId: string, role: TreeRole, wsId: string | null, nodeId: string, mode: 'to_bin' | 'to_parent',
): Promise<void> {
  await platformTx(async (tx) => {
    const node = await tx.get(
      `SELECT * FROM tag_node WHERE id=? AND app_id=? AND role=? AND ${wsCond(role)} FOR UPDATE`,
      wsParams(role, wsId, [nodeId, appId, role]),
    );
    if (!node) throw new HttpError(404, 'NODE_NOT_FOUND');
    if (node.kind_uniq) throw new HttpError(400, 'SYSTEM_NODE_IMMUTABLE');
    const children = await tx.query('SELECT COUNT(*) AS c FROM tag_node WHERE parent_id=?', [nodeId]);
    const placements = await tx.query('SELECT COUNT(*) AS c FROM report_placement WHERE tag_node_id=?', [nodeId]);
    if (children[0].c > 0 || placements[0].c > 0) {
      if (mode === 'to_bin') {
        await tx.run('UPDATE report_placement SET tag_node_id=?, recycled_at=NOW() WHERE tag_node_id=?',
          [(await getRecycleBin(appId, role, wsId)).id, nodeId]);
      } else {
        const parent = node.parent_id ?? (await getRoot(appId, role, wsId)).id;
        await tx.run('UPDATE report_placement SET tag_node_id=? WHERE tag_node_id=?', [parent, nodeId]);
      }
      const parent = node.parent_id ?? (await getRoot(appId, role, wsId)).id;
      await tx.run('UPDATE tag_node SET parent_id=? WHERE parent_id=?', [parent, nodeId]);
    }
    await tx.run('DELETE FROM tag_node WHERE id=?', [nodeId]);
  });
}

// 兼容旧签名：建应用时只建甲方那棵；开发者树由 devWorkspace 服务按工作区逐个建
export async function initTrees(appId: string): Promise<void> {
  await initClientTree(appId);
}

export type { TreeRole };
