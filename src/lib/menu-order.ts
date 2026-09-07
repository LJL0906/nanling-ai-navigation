export const MENU_ORDER_KEY = 'nav:menu-order:v1';

export function normalizeMenuOrder(
  defaultIds: readonly string[],
  saved: unknown,
): string[] {
  const validIds = new Set(defaultIds);
  // 兼容旧版本将首页拖到中间的记录，首页始终固定在首位。
  const order = new Set<string>(validIds.has('/') ? ['/'] : []);

  if (Array.isArray(saved)) {
    for (const id of saved) {
      if (typeof id === 'string' && validIds.has(id)) {
        order.add(id);
      }
    }
  }

  for (const id of defaultIds) {
    order.add(id);
  }

  return [...order];
}

export function readMenuOrder(
  storage: { getItem(key: string): string | null },
  defaultIds: readonly string[],
): string[] {
  try {
    const saved = storage.getItem(MENU_ORDER_KEY);
    return normalizeMenuOrder(defaultIds, saved === null ? null : JSON.parse(saved));
  } catch {
    return normalizeMenuOrder(defaultIds, null);
  }
}

export function saveMenuOrder(
  storage: { setItem(key: string, value: string): void },
  ids: readonly string[],
): boolean {
  try {
    storage.setItem(MENU_ORDER_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}
