/** 仅允许本站绝对路径；同时拒绝编码和多重编码的分隔符、控制符及协议伪装。 */
export function safeAccountNext(value: string | null | undefined): string {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return '/';
  let decoded = value;
  for (let i = 0; i < 8; i++) {
    if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(decoded)) return '/';
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return '/'; }
    if (next === decoded) {
      const url = new URL(value, 'https://account.invalid');
      if (url.pathname.startsWith('//') || url.origin !== 'https://account.invalid' || /^\/(?:login|register)(?:\/|$)/i.test(url.pathname)) return '/';
      return url.pathname + url.search + url.hash;
    }
    decoded = next;
  }
  return '/';
}

