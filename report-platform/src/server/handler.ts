// 路由封装：解析 RoleContext + 统一错误映射（doc §5 统一错误结构）。
import { resolveContext } from './context';
import { toErrorResponse } from './errors';
import type { RoleContext } from '@/lib/types';

export async function withRole(
  req: Request,
  fn: (ctx: RoleContext, req: Request) => Promise<Response>,
): Promise<Response> {
  let ctx: RoleContext | undefined;
  try {
    ctx = await resolveContext(req);
  } catch (e) {
    // 解析失败时尚不知角色，按 CLIENT 处理（信息最小化）
    const { status, body } = toErrorResponse(e, 'CLIENT');
    return Response.json(body, { status });
  }
  try {
    return await fn(ctx, req);
  } catch (e) {
    // 已确定角色：开发者可见错误明细，甲方只看到「系统错误」（REQ-NFR-06、REQ-SEC-11）
    const { status, body } = toErrorResponse(e, ctx.role);
    return Response.json(body, { status });
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
