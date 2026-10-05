// 导出服务（doc §8）。进程内立即触发 + 兜底扫描；流式写 xlsx/csv；CSV 注入防护；脱敏一致。
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { pGet, pRun, pQuery } from '../db/platform';
import { getDsPool } from '../db/datasource';
import { withReadonlyConn, pageQuery } from '../sql/executor';
import { parse, bindValues } from '../sql/parser';
import { validate } from '../sql/validator';
import { rewriteBase } from '../sql/rewriter';
import { applyShape, parseSensitive } from '../sql/shape';
import { loadDataSource } from './datasource';
import { auditAction } from './audit';
import { HttpError } from '../errors';
import type { DataSourceRow, RoleContext } from '@/lib/types';

function exportDir(): string {
  return process.env.EXPORT_DIR || './data/exports';
}
function ensureDir() {
  fs.mkdirSync(exportDir(), { recursive: true });
}

export interface ExportReq {
  reportId?: string;
  sql: string;
  params: Record<string, unknown>;
  format: 'xlsx' | 'csv';
  dataSourceId: string;
}

export async function createExport(ctx: RoleContext, req: ExportReq): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await pRun(
    `INSERT INTO export_task (id,app_id,report_id,data_source_id,sql_text,params_json,format,status,client_key,started_at)
     VALUES (?,?,?,?,?,?,?,'RUNNING',?,NOW())`,
    [id, ctx.appId, req.reportId ?? null, req.dataSourceId, req.sql, JSON.stringify(req.params), req.format, ctx.clientKey],
  );
  // 进程内立即触发，不阻塞响应
  void runExportTask(id, ctx).catch(() => {});
  return { id };
}

// CSV 注入防护（doc §8.2）：以 = + - @ Tab CR 开头强制前置单引号
function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function runExportTask(id: string, ctx: RoleContext): Promise<void> {
  const task = await pGet<any>('SELECT * FROM export_task WHERE id=?', [id]);
  if (!task) return;
  const ds: DataSourceRow = await loadDataSource(task.data_source_id);
  const sensitive = parseSensitive(ds.sensitive_columns_json);
  const file = path.join(exportDir(), `${id}.${task.format}`);
  ensureDir();

  try {
    const { template, paramNames, ast } = parse(task.sql_text);
    validate(ast, task.sql_text, [ds.database_name]);
    const baseSql = rewriteBase(ast);
    const values = bindValues(paramNames, JSON.parse(task.params_json || '{}'));

    let rowCount = 0;
    await withReadonlyConn(ds, ctx.settings.timeoutMs, async (conn) => {
      if (task.format === 'xlsx') {
        // 动态导入：避免 exceljs 在路由加载期就被引入（其依赖 crc32 在某些受限网络不可用）
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file });
        const ws = wb.addWorksheet('sheet1');
        let headerDone = false;
        for await (const chunk of pageQuery(conn, baseSql, values)) {
          const shaped = applyShape(chunk, sensitive);
          if (!headerDone && shaped.length) {
            ws.columns = Object.keys(shaped[0]).map((k) => ({ header: k, key: k }));
            headerDone = true;
          }
          for (const r of shaped) ws.addRow(r).commit();
          rowCount += shaped.length;
        }
        ws.commit();
        await wb.commit();
      } else {
        const out = fs.createWriteStream(file);
        out.write('\uFEFF'); // BOM：Excel 打开中文 CSV 不乱码
        let headerDone = false;
        for await (const chunk of pageQuery(conn, baseSql, values)) {
          const shaped = applyShape(chunk, sensitive);
          if (!headerDone && shaped.length) {
            out.write(Object.keys(shaped[0]).map(csvCell).join(',') + '\n');
            headerDone = true;
          }
          for (const r of shaped) out.write(Object.values(r).map(csvCell).join(',') + '\n');
          rowCount += shaped.length;
        }
        await new Promise<void>((res) => out.end(res));
      }
    });

    await pRun(
      `UPDATE export_task SET status='DONE', file_key=?, row_count=?, expires_at=DATE_ADD(NOW(), INTERVAL ? HOUR), finished_at=NOW() WHERE id=?`,
      [file, rowCount, ctx.settings.exportFileTtlHours, id],
    );
  } catch (e) {
    await pRun('UPDATE export_task SET status=\'FAILED\', error_msg=?, finished_at=NOW() WHERE id=?', [
      e instanceof Error ? e.message : 'export failed', id,
    ]);
  }
}

export async function getExport(id: string): Promise<any> {
  return pGet<any>('SELECT * FROM export_task WHERE id=?', [id]);
}

export async function listMine(ctx: RoleContext): Promise<any[]> {
  return pQuery(
    `SELECT id,format,status,row_count,started_at,expires_at FROM export_task
     WHERE app_id=? AND client_key=? AND started_at > DATE_SUB(NOW(), INTERVAL 30 DAY) ORDER BY started_at DESC LIMIT 50`,
    [ctx.appId, ctx.clientKey],
  );
}

export async function rerun(id: string, ctx: RoleContext): Promise<void> {
  const task = await pGet<any>('SELECT * FROM export_task WHERE id=?', [id]);
  if (!task) throw new HttpError(404, 'EXPORT_NOT_FOUND');
  await pRun(`UPDATE export_task SET status='RUNNING', error_msg=NULL, started_at=NOW() WHERE id=?`, [id]);
  void runExportTask(id, ctx).catch(() => {});
}
