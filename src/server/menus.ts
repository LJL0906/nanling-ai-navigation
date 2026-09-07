import { createNavigationCache } from './navigation-cache.ts';
import { getStorageDriver } from './database-config.ts';
import { buildMenuSeed } from './menu-seed.ts';
import { HttpError } from './http.ts';
import { menuRevision, validateMenus, visibleMenus } from './menu-validation.ts';
import { readMysqlMenus, saveMysqlMenus, type MenuSnapshot } from './menu-store.ts';

/** 只合并 MySQL 在途读取；TTL 为零，完成后不保留快照，下一批重新读库。 */
const menuReads = createNavigationCache<MenuSnapshot>(0);

/** 查询接口与服务端组件共用；seed 路径保持原样。 */
export async function getMenuSnapshot(): Promise<MenuSnapshot> {
  if (getStorageDriver() === 'mysql') return menuReads.get(readMysqlMenus);
  const menus = validateMenus(buildMenuSeed().menus);
  return { menus, revision:menuRevision(menus), writable:false };
}
export const getPublicMenus = async () => visibleMenus((await getMenuSnapshot()).menus);
export async function saveMenus(value: unknown, revision: unknown): Promise<MenuSnapshot> {
  if (getStorageDriver() !== 'mysql') throw new HttpError(503,'MENU_READ_ONLY','种子模式不支持保存菜单，请切换 MySQL。');
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw new HttpError(400,'INVALID_MENU_REVISION','缺少有效版本，请重新加载菜单。');
  const snapshot = await saveMysqlMenus(validateMenus(value), revision);
  // 保存成功后断开旧在途读取，后续请求不能加入保存前的读取批次。
  menuReads.invalidate();
  return snapshot;
}
