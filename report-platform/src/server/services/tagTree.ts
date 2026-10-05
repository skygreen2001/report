// 标签树服务（doc §4、§10.2、REQ-TAG-01~07）。每角色一棵树，ROOT/RECYCLE_BIN 系统节点唯一。
import { pGet, pQuery, pRun, platformTx } from '../db/platform';
import { HttpError } from '../errors';
import crypto from 'node:crypto';
import type { RoleContext } from '@/lib/types';

const MAX_DEPTH = 5; // REQ-TAG-07

export async function initTrees(appId: string): Promise<void> {
  for (const role of ['CLIENT', 'DEVELOPER'] as const) {
    const existing = await pGet('SELECT id FROM tag_node WHERE app_id=? AND role=? AND kind_uniq=?', [appId, role, 'ROOT']);
    if (!existing) {
      await pRun('INSERT INTO tag_node (id,app_id,role,kind,name,kind_uniq,sort) VALUES (?,?,?,\'ROOT\',\'根目录\',\'ROOT\',0)', [crypto.randomUUID(), appId, role]);
    }
    const bin = await pGet('SELECT id FROM tag_node WHERE app_id=? AND role=? AND kind_uniq=?', [appId, role, 'RECYCLE_BIN']);
    if (!bin) {
      await pRun('INSERT INTO tag_node (id,app_id,role,kind,name,kind_uniq,sort) VALUES (?,?,?,\'RECYCLE_BIN\',\'回收站\',\'RECYCLE_BIN\',999)', [crypto.randomUUID(), appId, role]);
    }
  }
}

// 系统节点在建应用时就初始化，缺失属于数据异常 —— 直接抛错，避免调用方拿到 undefined 静默写坏 placement
export async function getRoot(appId: string, role: 'CLIENT' | 'DEVELOPER'): Promise<any> {
  const n = await pGet('SELECT * FROM tag_node WHERE app_id=? AND role=? AND kind_uniq=\'ROOT\'', [appId, role]);
  if (!n) throw new HttpError(500, 'ROOT_NODE_MISSING');
  return n;
}
export async function getRecycleBin(appId: string, role: 'CLIENT' | 'DEVELOPER'): Promise<any> {
  const n = await pGet('SELECT * FROM tag_node WHERE app_id=? AND role=? AND kind_uniq=\'RECYCLE_BIN\'', [appId, role]);
  if (!n) throw new HttpError(500, 'RECYCLE_BIN_MISSING');
  return n;
}

export async function listNodes(appId: string, role: 'CLIENT' | 'DEVELOPER') {
  return pQuery('SELECT * FROM tag_node WHERE app_id=? AND role=? ORDER BY sort, created_at', [appId, role]);
}

export async function createNode(appId: string, role: 'CLIENT' | 'DEVELOPER', name: string, parentId: string | null): Promise<string> {
  // 父不能是系统节点（ROOT 可作为父；RECYCLE_BIN 不可作为父）
  if (parentId) {
    const parent = await pGet('SELECT * FROM tag_node WHERE id=? AND app_id=? AND role=?', [parentId, appId, role]);
    if (!parent) throw new HttpError(404, 'NODE_NOT_FOUND');
    if (parent.kind_uniq === 'RECYCLE_BIN') throw new HttpError(400, 'CANNOT_ADD_UNDER_BIN');
    const depth = await depthOf(appId, role, parentId);
    if (depth >= MAX_DEPTH) throw new HttpError(400, 'MAX_DEPTH_EXCEEDED'); // REQ-TAG-07
  }
  const id = crypto.randomUUID();
  await pRun('INSERT INTO tag_node (id,app_id,role,kind,name,parent_id,sort) VALUES (?,?,?,\'NORMAL\',?,?,0)', [id, appId, role, name, parentId]);
  return id;
}

async function depthOf(appId: string, role: 'CLIENT' | 'DEVELOPER', nodeId: string): Promise<number> {
  let depth = 1;
  let cur = await pGet('SELECT parent_id FROM tag_node WHERE id=? AND app_id=? AND role=?', [nodeId, appId, role]);
  while (cur?.parent_id) {
    depth++;
    cur = await pGet('SELECT parent_id FROM tag_node WHERE id=? AND app_id=? AND role=?', [cur.parent_id, appId, role]);
  }
  return depth;
}

export async function renameNode(appId: string, role: 'CLIENT' | 'DEVELOPER', nodeId: string, name: string): Promise<void> {
  const node = await pGet('SELECT * FROM tag_node WHERE id=? AND app_id=? AND role=?', [nodeId, appId, role]);
  if (!node) throw new HttpError(404, 'NODE_NOT_FOUND');
  if (node.kind_uniq) throw new HttpError(400, 'SYSTEM_NODE_IMMUTABLE'); // REQ-TAG-03
  await pRun('UPDATE tag_node SET name=? WHERE id=?', [name, nodeId]);
}

export async function deleteNode(appId: string, role: 'CLIENT' | 'DEVELOPER', nodeId: string, mode: 'to_bin' | 'to_parent'): Promise<void> {
  await platformTx(async (tx) => {
    const node = await tx.get('SELECT * FROM tag_node WHERE id=? AND app_id=? AND role=? FOR UPDATE', [nodeId, appId, role]);
    if (!node) throw new HttpError(404, 'NODE_NOT_FOUND');
    if (node.kind_uniq) throw new HttpError(400, 'SYSTEM_NODE_IMMUTABLE');
    const children = await tx.query('SELECT COUNT(*) AS c FROM tag_node WHERE parent_id=?', [nodeId]);
    const placements = await tx.query('SELECT COUNT(*) AS c FROM report_placement WHERE tag_node_id=?', [nodeId]);
    if (children[0].c > 0 || placements[0].c > 0) {
      if (mode === 'to_bin') {
        // 报表移入回收站（REQ-TAG-06）
        await tx.run('UPDATE report_placement SET tag_node_id=?, recycled_at=NOW() WHERE tag_node_id=?', [(await getRecycleBin(appId, role)).id, nodeId]);
      } else {
        // 报表移到父目录
        const parent = node.parent_id ?? (await getRoot(appId, role)).id;
        await tx.run('UPDATE report_placement SET tag_node_id=? WHERE tag_node_id=?', [parent, nodeId]);
      }
      // 子目录递归处理（简化为直接挂到父）
      await tx.run('UPDATE tag_node SET parent_id=? WHERE parent_id=?', [node.parent_id ?? (await getRoot(appId, role)).id, nodeId]);
    }
    await tx.run('DELETE FROM tag_node WHERE id=?', [nodeId]);
  });
}
