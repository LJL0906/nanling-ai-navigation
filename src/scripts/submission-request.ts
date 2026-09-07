/** 提交采用首击立即执行 + 进行中互斥，而不是延迟用户操作的尾沿防抖。 */
function requestUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // 局域网 HTTP 预览下 randomUUID 可能不可用，仍使用安全随机数，不用 Math.random。
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function createSubmissionGate(now = Date.now, uuid = requestUuid) {
  let active = false;
  let lastStarted = -Infinity;
  let body = '';
  let key = '';
  return {
    start(): boolean {
      const time = now();
      if (active || time - lastStarted < 800) return false;
      active = true;
      lastStarted = time;
      return true;
    },
    finish() { active = false; },
    keyFor(payload: string): string {
      if (body !== payload || !key) { body = payload; key = uuid(); }
      return key;
    },
    reset() { body = ''; key = ''; lastStarted = -Infinity; },
  };
}

/** 覆盖读取响应体的整个过程；超时不意味着服务端一定没有保存成功。 */
export async function fetchSubmissionJson(url: string, options: RequestInit = {}, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error('服务响应异常，请稍后重试；已填写内容会保留。');
    }
    if (!response.ok) {
      throw Object.assign(new Error(typeof data.error?.message === 'string' ? data.error.message : '提交失败，请稍后重试。'), { status: response.status });
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('等待响应超时，结果尚未确认。可保留原内容重试，系统会核对重复提交。');
    if (error instanceof TypeError) throw new Error('网络连接失败，请稍后重试；已填写内容会保留。');
    throw error;
  } finally { clearTimeout(timer); }
}

