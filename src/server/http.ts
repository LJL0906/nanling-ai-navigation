/** 明确的公开错误，避免把数据库异常、连接信息或堆栈发到浏览器。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export async function api(action: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const value = await action();
    return value instanceof Response ? value : json(value);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: { code: error.code, message: error.message } }, error.status);
    }
    // 不记录原始异常，避免未来数据库驱动把连接串写入日志。
    console.error('[api] 请求处理失败');
    return json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' } }, 500);
  }
}

export function methodNotAllowed(allow = 'GET, HEAD'): Response {
  return json({ error: { code: 'METHOD_NOT_ALLOWED', message: '当前接口不支持此方法。' } }, 405, { Allow: allow });
}
