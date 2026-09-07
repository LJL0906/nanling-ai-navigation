import type { NavigationSnapshot } from './repository';

export const NAVIGATION_CACHE_TTL_MS = 30_000;

/**
 * 仅进程内共享，无跨进程失效广播；其他进程最多在 TTL 内继续命中旧快照。
 * TTL 从加载开始计时，慢查询不会延长陈旧窗口；已在途读取可以返回原快照。
 * 不缓存失败、不在刷新失败时回退过期数据。失效后的旧请求不能回填或清除新请求。
 */
export function createNavigationCache<T>(
  ttlMs = NAVIGATION_CACHE_TTL_MS,
  now: () => number = () => performance.now(),
) {
  let generation = 0;
  let cached: { value: T; expiresAt: number } | undefined;
  let inFlight: Promise<T> | undefined;

  function get(load: () => Promise<T>): Promise<T> {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.value);
    cached = undefined;
    if (inFlight) return inFlight;
    const startedAt = now();
    const currentGeneration = generation;
    const request = Promise.resolve().then(load).then(value => {
      if (generation === currentGeneration && now() < startedAt + ttlMs) {
        cached = { value, expiresAt: startedAt + ttlMs };
      }
      return value;
    }).finally(() => {
      if (inFlight === request) inFlight = undefined;
    });
    inFlight = request;
    return request;
  }

  function invalidate(): void {
    generation++;
    cached = undefined;
    inFlight = undefined;
  }

  return { get, invalidate };
}

export const navigationCache = createNavigationCache<NavigationSnapshot>();
