"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createExport = createExport;
exports.runExportTask = runExportTask;
exports.getExport = getExport;
exports.listMine = listMine;
exports.rerun = rerun;
// 导出服务（doc §8）。进程内立即触发 + 兜底扫描；流式写 xlsx/csv；CSV 注入防护；脱敏一致。
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const platform_1 = require("../db/platform");
const executor_1 = require("../sql/executor");
const parser_1 = require("../sql/parser");
const validator_1 = require("../sql/validator");
const rewriter_1 = require("../sql/rewriter");
const shape_1 = require("../sql/shape");
const datasource_1 = require("./datasource");
const errors_1 = require("../errors");
function exportDir() {
    return process.env.EXPORT_DIR || './data/exports';
}
function ensureDir() {
    fs_1.default.mkdirSync(exportDir(), { recursive: true });
}
async function createExport(ctx, req) {
    const id = node_crypto_1.default.randomUUID();
    await (0, platform_1.pRun)(`INSERT INTO export_task (id,app_id,report_id,data_source_id,sql_text,params_json,format,status,client_key,started_at)
     VALUES (?,?,?,?,?,?,?,'RUNNING',?,NOW())`, [id, ctx.appId, req.reportId ?? null, req.dataSourceId, req.sql, JSON.stringify(req.params), req.format, ctx.clientKey]);
    // 进程内立即触发，不阻塞响应
    void runExportTask(id, ctx).catch(() => { });
    return { id };
}
// CSV 注入防护（doc §8.2）：以 = + - @ Tab CR 开头强制前置单引号
function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s))
        s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
}
async function runExportTask(id, ctx) {
    const task = await (0, platform_1.pGet)('SELECT * FROM export_task WHERE id=?', [id]);
    if (!task)
        return;
    const ds = await (0, datasource_1.loadDataSource)(task.data_source_id);
    const sensitive = (0, shape_1.parseSensitive)(ds.sensitive_columns_json);
    const file = path_1.default.join(exportDir(), `${id}.${task.format}`);
    ensureDir();
    try {
        const { template, paramNames, ast } = (0, parser_1.parse)(task.sql_text);
        (0, validator_1.validate)(ast, task.sql_text, [ds.database_name]);
        const baseSql = (0, rewriter_1.rewriteBase)(ast);
        const values = (0, parser_1.bindValues)(paramNames, JSON.parse(task.params_json || '{}'));
        let rowCount = 0;
        await (0, executor_1.withReadonlyConn)(ds, ctx.settings.timeoutMs, async (conn) => {
            if (task.format === 'xlsx') {
                // 动态导入：避免 exceljs 在路由加载期就被引入（其依赖 crc32 在某些受限网络不可用）
                const ExcelJS = (await Promise.resolve().then(() => __importStar(require('exceljs')))).default;
                const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file });
                const ws = wb.addWorksheet('sheet1');
                let headerDone = false;
                for await (const chunk of (0, executor_1.pageQuery)(conn, baseSql, values)) {
                    const shaped = (0, shape_1.applyShape)(chunk, sensitive);
                    if (!headerDone && shaped.length) {
                        ws.columns = Object.keys(shaped[0]).map((k) => ({ header: k, key: k }));
                        headerDone = true;
                    }
                    for (const r of shaped)
                        ws.addRow(r).commit();
                    rowCount += shaped.length;
                }
                ws.commit();
                await wb.commit();
            }
            else {
                const out = fs_1.default.createWriteStream(file);
                out.write('\uFEFF'); // BOM：Excel 打开中文 CSV 不乱码
                let headerDone = false;
                for await (const chunk of (0, executor_1.pageQuery)(conn, baseSql, values)) {
                    const shaped = (0, shape_1.applyShape)(chunk, sensitive);
                    if (!headerDone && shaped.length) {
                        out.write(Object.keys(shaped[0]).map(csvCell).join(',') + '\n');
                        headerDone = true;
                    }
                    for (const r of shaped)
                        out.write(Object.values(r).map(csvCell).join(',') + '\n');
                    rowCount += shaped.length;
                }
                await new Promise((res) => out.end(res));
            }
        });
        await (0, platform_1.pRun)(`UPDATE export_task SET status='DONE', file_key=?, row_count=?, expires_at=DATE_ADD(NOW(), INTERVAL ? HOUR), finished_at=NOW() WHERE id=?`, [file, rowCount, ctx.settings.exportFileTtlHours, id]);
    }
    catch (e) {
        await (0, platform_1.pRun)('UPDATE export_task SET status=\'FAILED\', error_msg=?, finished_at=NOW() WHERE id=?', [
            e instanceof Error ? e.message : 'export failed', id,
        ]);
    }
}
async function getExport(id) {
    return (0, platform_1.pGet)('SELECT * FROM export_task WHERE id=?', [id]);
}
async function listMine(ctx) {
    return (0, platform_1.pQuery)(`SELECT id,format,status,row_count,started_at,expires_at FROM export_task
     WHERE app_id=? AND client_key=? AND started_at > DATE_SUB(NOW(), INTERVAL 30 DAY) ORDER BY started_at DESC LIMIT 50`, [ctx.appId, ctx.clientKey]);
}
async function rerun(id, ctx) {
    const task = await (0, platform_1.pGet)('SELECT * FROM export_task WHERE id=?', [id]);
    if (!task)
        throw new errors_1.HttpError(404, 'EXPORT_NOT_FOUND');
    await (0, platform_1.pRun)(`UPDATE export_task SET status='RUNNING', error_msg=NULL, started_at=NOW() WHERE id=?`, [id]);
    void runExportTask(id, ctx).catch(() => { });
}
