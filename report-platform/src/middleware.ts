// Edge 中间件（doc §2.2）：只做 rewrite + clientKey Cookie，不查库（无 TCP）。
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const seg = pathname.split('/').filter(Boolean);
  const appPath = seg[0];
  const roleSeg = seg[1];

  // /{appPath}/{c|d}/*  →  /tenant/{appPath}/{c|d}/*  （rewrite 目标不以 _ 开头，见 §15.2 修正1）
  if ((roleSeg === 'c' || roleSeg === 'd') && !pathname.startsWith('/tenant/')) {
    const rest = seg.slice(2).join('/');
    const url = req.nextUrl.clone();
    url.pathname = `/tenant/${appPath}/${roleSeg}${rest ? '/' + rest : ''}`;

    // rewrite 之后，路由处理器看到的 URL 已变成 /tenant/... ，
    // 因此把 appPath / role 显式放进请求头，避免下游再按路径猜（doc §2.2、§15.2 修正1）
    const headers = new Headers(req.headers);
    headers.set('x-app-path', appPath);
    headers.set('x-role', roleSeg);
    const res = NextResponse.rewrite(url, { request: { headers } });
    if (!req.cookies.get('clientKey')) {
      // HttpOnly + SameSite=Lax（doc §2.1）。导出历史依赖此 Cookie（Q-13）。
      res.cookies.set('clientKey', crypto.randomUUID(), { httpOnly: true, sameSite: 'lax', path: '/' });
    }
    return res;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|api/auth).*)'],
};
