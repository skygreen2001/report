"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initTrees = initTrees;
exports.getRoot = getRoot;
exports.getRecycleBin = getRecycleBin;
exports.listNodes = listNodes;
exports.createNode = createNode;
exports.renameNode = renameNode;
exports.deleteNode = deleteNode;
// 标签树服务（doc §4、§10.2、REQ-TAG-01~07）。每角色一棵树，ROOT/RECYCLE_BIN 系统节点唯一。
const platform_1 = require("../db/platform");
const errors_1 = require("../errors");
const node_crypto_1 = __importDefault(require("node:crypto"));
const MAX_DEPTH = 5; // REQ-TAG-07
async function initTrees(appId) {
    for (const role of ['CLIENT', 'DEVELOPER']) {
        const existing = await (0, platform_1.pGet)('SELECT id FROM tag_node WHERE app_id=? AND role=? AND kind_uniq=?', [appId, role, 'ROOT']);
        if (!existing) {
            await (0, platform_1.pRun)('INSERT INTO tag_node (id,app_id,role,kind,name,kind_uniq,sort) VALUES (?,?,?,\'ROOT\',\'根目录\',\'ROOT\',0)', [node_crypto_1.default.randomUUID(), appId, role]);
        }
        const bin = await (0, platform_1.pGet)('SELECT id FROM tag_node WHERE app_id=? AND role=? AND kind_uniq=?', [appId, role, 'RECYCLE_BIN']);
        if (!bin) {
            await (0, platform_1.pRun)('INSERT INTO tag_node (id,app_id,role,kind,name,kind_uniq,sort) VALUES (?,?,?,\'RECYCLE_BIN\',\'回收站\',\'RECYCLE_BIN\',999)', [node_crypto_1.default.randomUUID(), appId, role]);
        }
    }
}
async function getRoot(appId, role) {
    return (0, platform_1.pGet)('SELECT * FROM tag_node WHERE app_id=? AND role=? AND kind_uniq=\'ROOT\'', [appId, role]);
}
async function getRecycleBin(appId, role) {
    return (0, platform_1.pGet)('SELECT * FROM tag_node WHERE app_id=? AND role=? AND kind_uniq=\'RECYCLE_BIN\'', [appId, role]);
}
async function listNodes(appId, role) {
    return (0, platform_1.pQuery)('SELECT * FROM tag_node WHERE app_id=? AND role=? ORDER BY sort, created_at', [appId, role]);
}
async function createNode(appId, role, name, parentId) {
    // 父不能是系统节点（ROOT 可作为父；RECYCLE_BIN 不可作为父）
    if (parentId) {
        const parent = await (0, platform_1.pGet)('SELECT * FROM tag_node WHERE id=? AND app_id=? AND role=?', [parentId, appId, role]);
        if (!parent)
            throw new errors_1.HttpError(404, 'NODE_NOT_FOUND');
        if (parent.kind_uniq === 'RECYCLE_BIN')
            throw new errors_1.HttpError(400, 'CANNOT_ADD_UNDER_BIN');
        const depth = await depthOf(appId, role, parentId);
        if (depth >= MAX_DEPTH)
            throw new errors_1.HttpError(400, 'MAX_DEPTH_EXCEEDED'); // REQ-TAG-07
    }
    const id = node_crypto_1.default.randomUUID();
    await (0, platform_1.pRun)('INSERT INTO tag_node (id,app_id,role,kind,name,parent_id,sort) VALUES (?,?,?,\'NORMAL\',?,?,0)', [id, appId, role, name, parentId]);
    return id;
}
async function depthOf(appId, role, nodeId) {
    let depth = 1;
    let cur = await (0, platform_1.pGet)('SELECT parent_id FROM tag_node WHERE id=? AND app_id=? AND role=?', [nodeId, appId, role]);
    while (cur?.parent_id) {
        depth++;
        cur = await (0, platform_1.pGet)('SELECT parent_id FROM tag_node WHERE id=? AND app_id=? AND role=?', [cur.parent_id, appId, role]);
    }
    return depth;
}
async function renameNode(appId, role, nodeId, name) {
    const node = await (0, platform_1.pGet)('SELECT * FROM tag_node WHERE id=? AND app_id=? AND role=?', [nodeId, appId, role]);
    if (!node)
        throw new errors_1.HttpError(404, 'NODE_NOT_FOUND');
    if (node.kind_uniq)
        throw new errors_1.HttpError(400, 'SYSTEM_NODE_IMMUTABLE'); // REQ-TAG-03
    await (0, platform_1.pRun)('UPDATE tag_node SET name=? WHERE id=?', [name, nodeId]);
}
async function deleteNode(appId, role, nodeId, mode) {
    await (0, platform_1.platformTx)(async (tx) => {
        const node = await tx.get('SELECT * FROM tag_node WHERE id=? AND app_id=? AND role=? FOR UPDATE', [nodeId, appId, role]);
        if (!node)
            throw new errors_1.HttpError(404, 'NODE_NOT_FOUND');
        if (node.kind_uniq)
            throw new errors_1.HttpError(400, 'SYSTEM_NODE_IMMUTABLE');
        const children = await tx.query('SELECT COUNT(*) AS c FROM tag_node WHERE parent_id=?', [nodeId]);
        const placements = await tx.query('SELECT COUNT(*) AS c FROM report_placement WHERE tag_node_id=?', [nodeId]);
        if (children[0].c > 0 || placements[0].c > 0) {
            if (mode === 'to_bin') {
                // 报表移入回收站（REQ-TAG-06）
                await tx.run('UPDATE report_placement SET tag_node_id=?, recycled_at=NOW() WHERE tag_node_id=?', [(await getRecycleBin(appId, role)).id, nodeId]);
            }
            else {
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
