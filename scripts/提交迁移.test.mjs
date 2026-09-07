import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLegacySubmission, importLegacySubmissions } from './迁移站点提交.mjs';
const record = {id:'781630c0-8a46-4aab-8e8d-d8c78d7e95a3',name:'测试站点',url:'https://example.test/',categoryId:'ai',customCategory:'',iconUrl:'',iconData:'',remark:'审核备注',status:'pending',createdAt:'2026-09-07T00:00:00.000Z'};
test('旧记录验证保留备注，拒绝错误编号和状态', () => {
  assert.equal(validateLegacySubmission(record, `${record.id}.json`), record);
  assert.throws(() => validateLegacySubmission({...record,status:'other'},`${record.id}.json`));
  assert.throws(() => validateLegacySubmission(record,'../bad.json'));
});
test('迁移只插入缺失记录、重放不覆盖、冲突回滚', async () => {
  const rows = new Map(); let rollback = false; let commits = 0;
  const db={beginTransaction:async()=>{},commit:async()=>{commits++;},rollback:async()=>{rollback=true;},execute:async(sql,values)=>{
    if(sql.startsWith('SELECT')) return [[...(rows.has(values[0])?[{payload:rows.get(values[0])}]:[])]];
    assert.equal(values[1],null); rows.set(values[0],JSON.parse(values[3])); return [{}];
  }};
  assert.deepEqual(await importLegacySubmissions(db,[record]),{inserted:1,skipped:0});
  assert.deepEqual(await importLegacySubmissions(db,[record]),{inserted:0,skipped:1});
  await assert.rejects(importLegacySubmissions(db,[{...record,remark:'变更'}]),/不会覆盖/);
  assert.equal(rollback,true); assert.equal(commits,2); assert.deepEqual(rows.get(record.id),record);
});
