import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { withAccountConnection } from './account-db.ts';
import { HttpError } from './http.ts';
import type { PersonalAction } from './personal-validation.ts';
import type { PersonalRecord, PersonalKind } from '../lib/personal-store.ts';
export interface PersonalSnapshot { favorites: PersonalRecord[]; history: PersonalRecord[] }
async function snapshot(connection: PoolConnection, userId: string): Promise<PersonalSnapshot> {
  const [rows] = await connection.execute<RowDataPacket[]>("SELECT kind,site_id,DATE_FORMAT(updated_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS stamp,visit_type FROM nav_user_records WHERE user_id=? ORDER BY updated_at DESC,site_id", [userId]);
  const result: PersonalSnapshot = { favorites:[], history:[] };
  for (const row of rows) result[row.kind as PersonalKind].push({siteId:row.site_id,updatedAt:new Date(row.stamp).toISOString(),...(row.visit_type ? {visitType:row.visit_type} : {})});
  return result;
}
export const readPersonal = (userId: string) => withAccountConnection(c => snapshot(c,userId));
const sqlTime = (value: string) => value.slice(0,23).replace('T',' ');
export async function writePersonalTransaction(c: PoolConnection, userId: string, operation: PersonalAction): Promise<PersonalSnapshot> {
  await c.beginTransaction();
  try {
    // 锁账号行使同一账号多设备写入串行，避免历史限额和迁移合并竞争。
    const [users] = await c.execute<RowDataPacket[]>('SELECT id FROM nav_users WHERE id=? FOR UPDATE',[userId]);
    if (!users.length) throw new HttpError(401,'LOGIN_REQUIRED','请先登录。');
    const now = sqlTime(new Date().toISOString());
    const upsert = async (kind: PersonalKind, record: PersonalRecord, importing = false) => {
      const [sites] = await c.execute<RowDataPacket[]>('SELECT id FROM nav_sites WHERE id=?',[record.siteId]);
      if (!sites.length) {
        if (importing) return;
        throw new HttpError(404,'SITE_NOT_FOUND','站点不存在或已下架。');
      }
      await c.execute(`INSERT INTO nav_user_records (user_id,kind,site_id,updated_at,visit_type) VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE visit_type=IF(VALUES(updated_at)>=updated_at,VALUES(visit_type),visit_type),updated_at=GREATEST(updated_at,VALUES(updated_at))`,
        [userId,kind,record.siteId,sqlTime(record.updatedAt),kind === 'history' ? record.visitType ?? 'external' : null]);
    };
    if (operation.action === 'favorite') {
      if (operation.selected) await upsert('favorites',{siteId:operation.siteId,updatedAt:new Date().toISOString()});
      else await c.execute("DELETE FROM nav_user_records WHERE user_id=? AND kind='favorites' AND site_id=?",[userId,operation.siteId]);
    } else if (operation.action === 'visit') {
      await upsert('history',{siteId:operation.siteId,updatedAt:now.replace(' ','T')+'Z',visitType:operation.visitType});
    } else if (operation.action === 'remove') {
      await c.execute('DELETE FROM nav_user_records WHERE user_id=? AND kind=? AND site_id=?',[userId,operation.kind,operation.siteId]);
    } else if (operation.action === 'clear') {
      await c.execute('DELETE FROM nav_user_records WHERE user_id=? AND kind=?',[userId,operation.kind]);
    } else {
      for (const record of operation.favorites) await upsert('favorites',record,true);
      for (const record of operation.history) await upsert('history',record,true);
    }
    const [overflow] = await c.execute<RowDataPacket[]>("SELECT site_id FROM nav_user_records WHERE user_id=? AND kind='history' ORDER BY updated_at DESC,site_id LIMIT 100,10000",[userId]);
    for (const row of overflow) await c.execute("DELETE FROM nav_user_records WHERE user_id=? AND kind='history' AND site_id=?",[userId,row.site_id]);
    const result = await snapshot(c,userId);
    await c.commit(); return result;
  } catch (error) { await c.rollback(); throw error; }
}
export const writePersonal = (userId: string, operation: PersonalAction) => withAccountConnection(c => writePersonalTransaction(c,userId,operation));
