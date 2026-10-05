export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { withRole, json } from '@/server/handler';
import { getExport, rerun } from '@/server/services/export';
import { HttpError } from '@/server/errors';
import fs from 'fs';

// GET /exports/{id} —— 任务状态 / 下载（REQ-EXP-04）
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    const task = await getExport(id);
    if (!task) throw new HttpError(404, 'EXPORT_NOT_FOUND');
    if (task.status !== 'DONE' || !task.file_key) {
      return json({ id: task.id, status: task.status, rowCount: task.row_count, error: task.error_msg });
    }
    if (!fs.existsSync(task.file_key)) throw new HttpError(404, 'FILE_EXPIRED');
    const buf = fs.readFileSync(task.file_key);
    const ext = task.format;
    const ctype = ext === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8';
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': ctype,
        'Content-Disposition': `attachment; filename="report.${ext}"`,
      },
    });
  });
}

// POST /exports/{id}:rerun —— 过期重跑（REQ-EXP-09）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRole(req, async (ctx) => {
    await rerun(id, ctx);
    return json({ id, status: 'RUNNING' });
  });
}
