import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMySqlSubmissionRepository } from '../src/server/mysql-submissions.ts';
import { createNotificationStore, notificationQuery, notificationScope, validateAnnouncement, announcementRevision } from '../src/server/notifications.ts';
import { createNotificationHandler, createAnnouncementHandler } from '../src/server/notifications-handler.ts';
import { writeSiteNotification, writeSubmissionNotification } from '../src/server/notifications-events.ts';
import { createContentStore } from '../src/server/content-store.ts';
import { createContentHandler } from '../src/server/content-handler.ts';
import { publishSubmission } from '../src/server/submission-publish.ts';
import { createSubmissionHandler, validateSubmission } from '../src/server/site-submissions.ts';
import { HttpError } from '../src/server/http.ts';
import { migrateNotifications } from './迁移通知与提交归属.mjs';

const owner = randomUUID(), other = randomUUID();
const data = { categoryId: 'ai', customCategory: '', name: 'Example', url: 'https://new.test/', iconUrl: '', iconData: '', remark: 'contact private@example.test' };
const is = (status) => e => e.status === status;
function dbFixture({ fail = () => false, legacy = false } = {}) {
  let state = { submissions: new Map(), events: [], sites: [
    { id: 'old', slug: 'old', category_id: 'ai', sort_order: 0, payload: { name: 'Old', url: 'https://old.test/', sources: [] } },
    { id: 'keep', slug: 'keep', category_id: 'ai', sort_order: 1, payload: { name: 'Keep', url: 'https://keep.test/', sources: [] } },
  ], records: [{ site_id: 'old', user_id: owner }] };
  let undo; const calls = [];
  const categories = [{ id: 'ai', slug: 'ai', sort_order: 0, payload: { name: 'AI', order: 0 } }];
  const c = {
    async beginTransaction() { calls.push('BEGIN'); undo = structuredClone(state); },
    async commit() { calls.push('COMMIT'); if (fail('COMMIT')) throw new Error('secret'); undo = undefined; },
    async rollback() { calls.push('ROLLBACK'); if (undo) state = undo; undo = undefined; },
    release() { calls.push('RELEASE'); }, destroy() { calls.push('DESTROY'); },
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (fail(sql)) throw new Error('secret');
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('SET ')) return [[]];
      if (sql.startsWith('SELECT') && sql.includes('FROM nav_categories')) return [structuredClone(categories)];
      if (sql.startsWith('SELECT') && sql.includes('FROM nav_sites')) return [structuredClone(state.sites)];
      if (sql.startsWith('SELECT * FROM nav_submissions WHERE id')) return [[state.submissions.get(values[0])].filter(Boolean).map(v => structuredClone(v))];
      if (sql.startsWith('INSERT INTO nav_submissions')) {
        const [id, request_digest, status, payload, created_at, user_id] = values;
        state.submissions.set(id, { id, request_digest, status, payload, created_at, user_id: legacy ? null : user_id }); return [{}];
      }
      if (sql.startsWith('UPDATE nav_submissions')) {
        const [status, payload, reviewed_at, published_site_id, id] = values;
        Object.assign(state.submissions.get(id), { status, payload, reviewed_at, published_site_id }); return [{}];
      }
      if (sql.startsWith('INSERT INTO nav_notifications')) {
        if (state.events.some(e => e.values[1] === values[1])) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
        state.events.push({ sql, values: structuredClone(values) }); return [{}];
      }
      if (sql.startsWith('INSERT INTO nav_sites')) {
        const [id, category_id, slug, sort_order, payload] = values;
        state.sites.push({ id, category_id, slug, sort_order, payload: JSON.parse(payload) }); return [{}];
      }
      if (sql.startsWith('DELETE FROM nav_user_records')) { state.records = state.records.filter(r => r.site_id !== values[0]); return [{}]; }
      if (sql.startsWith('DELETE FROM nav_sites')) { state.sites = state.sites.filter(r => r.id !== values[0]); return [{}]; }
      assert.fail(`unexpected SQL ${sql}`);
    },
    execute(sql, values) { return this.query(sql, values); },
  };
  const pool = { async getConnection() { return c; } };
  return { pool, c, calls, get state() { return state; } };
}
const upload = async () => { throw new Error('unexpected upload'); };
const submit = (repo, id = randomUUID(), user = owner) => repo.submitToMySql(data, id, upload, () => {}, '', user);

test('查询严格三类、分页范围、重复与未知参数拒绝', () => {
  assert.deepEqual(notificationQuery(new URLSearchParams()), { kind: 'all', page: 1, pageSize: 20 });
  for (const query of ['kind=private','kind=site&kind=site','page=0','pageSize=101','page=1.2','page=1000001','x=1']) {
    assert.throws(() => notificationQuery(new URLSearchParams(query)), is(400));
  }
  assert.throws(() => notificationQuery(new URLSearchParams('kind=site'), true), is(400));
});
test('SQL visibility + recipient + kind 联合限定；匿名 all 无私人 OR', () => {
  const publicOnly = notificationScope('all', null);
  assert.match(publicOnly.sql, /visibility = 'public'.*recipient_user_id IS NULL/);
  assert.ok(!publicOnly.sql.includes(' OR '));
  assert.deepEqual(notificationScope('submission', owner).values, [owner, 'submission']);
  assert.match(notificationScope('submission', owner).sql, /visibility = 'private'.*recipient_user_id = \?/);
  assert.deepEqual(notificationScope('all', owner).values, [owner]);
  assert.match(notificationScope('site', owner).sql, /kind = \?$/);
  assert.throws(() => notificationScope('submission', null), is(401));
});
test('匿名在校验、限流、分类和上传前401，body userId 不能伪造身份', async () => {
  const previous = process.env.NAV_STORAGE; process.env.NAV_STORAGE = 'mysql';
  try {
    const handler = createSubmissionHandler({ getCategories: async () => assert.fail('匿名不可读取分类'), uploadIcon: async () => assert.fail('匿名不可上传') });
    const res = await handler(new Request('https://test/api/submissions', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://test' }, body: JSON.stringify({...data,userId:owner}) }), '127.0.0.1');
    assert.equal(res.status, 401);
    const empty = await handler(new Request('https://test/api/submissions', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://test' }, body: '{}' }), 'empty');
    assert.equal(empty.status, 401);
    for (let i=0;i<8;i++) assert.equal((await handler(new Request('https://test/api/submissions',{method:'POST',body:'{}'}),'same-anonymous')).status,401);
    assert.throws(() => validateSubmission({...data,userId:owner}, [{id:'ai'}]), is(400));
  } finally { if (previous === undefined) delete process.env.NAV_STORAGE; else process.env.NAV_STORAGE = previous; }
});
test('登录提交 owner 与私人成功事件同事务，非法 owner 被拒绝', async () => {
  const db = dbFixture(); const repo = createMySqlSubmissionRepository({getPool:()=>db.pool});
  await assert.rejects(repo.submitToMySql(data,randomUUID(),upload,()=>{},'', 'invalid'), is(400));
  await assert.rejects(repo.submitToMySql(data,randomUUID(),upload,()=>assert.fail('无owner不扣配额')), is(401));
  const result = await submit(repo);
  assert.equal(db.state.submissions.get(result.id).user_id, owner);
  assert.equal(JSON.parse(db.state.submissions.get(result.id).payload).userId, owner);
  assert.equal(db.state.events[0].values[2], owner);
  assert.equal(db.state.events[0].values[4], `已保存提交，等待审核：${data.name}\n${data.url}`);
  assert.ok(!JSON.stringify(db.state.events).includes('private@example.test'));
  assert.ok(db.calls.indexOf('BEGIN') < db.calls.findIndex(v => v.sql?.startsWith('INSERT INTO nav_notifications')));
  assert.ok(db.calls.includes('COMMIT'));
});
test('幂等按账号隔离，拒绝新匿名，历史匿名不可认领', async () => {
  const db = dbFixture(); const repo = createMySqlSubmissionRepository({getPool:()=>db.pool});
  const key=randomUUID(); const first=await submit(repo,key);
  assert.deepEqual(await submit(repo,key),first);
  const second=await submit(repo,key,other);
  await assert.rejects(submit(repo,key,null),is(401));
  assert.notEqual(first.id,second.id);
  assert.equal(db.state.events.length,2);
  // 手工迁移的旧匿名编号与客户端原 key 相同，也不被本次任何 scope 读取。
  db.state.submissions.set(key,{id:key,user_id:null,payload:JSON.stringify(data),request_digest:null,status:'pending'});
  assert.deepEqual(await submit(repo,key),first);
  db.state.submissions.get(first.id).user_id=null;
  await assert.rejects(submit(repo,key),is(409));
});
test('历史匿名审核通过只写全体新增，驳回无私人通知，永不猜测owner', async () => {
  const db=dbFixture(); const repo=createMySqlSubmissionRepository({getPool:()=>db.pool});
  const id=randomUUID();
  db.state.submissions.set(id,{id,user_id:null,status:'pending',payload:JSON.stringify({...data,id,status:'pending',userId:owner})});
  await repo.reviewMySqlSubmission(id,'approved','历史匿名审核','admin');
  assert.equal(db.state.events.length,1);
  assert.ok(db.state.events[0].sql.includes("'site', 'public'"));
  const second=randomUUID();
  db.state.submissions.set(second,{id:second,user_id:null,status:'pending',payload:JSON.stringify({...data,id:second,status:'pending'})});
  await repo.reviewMySqlSubmission(second,'rejected','历史匿名拒绝','admin');
  assert.equal(db.state.events.length,1);
});
test('提交事件失败/commit失败回滚 owner 和提交', async () => {
  for (const fail of [sql=>sql.startsWith('INSERT INTO nav_notifications'),sql=>sql==='COMMIT']) {
    const db=dbFixture({fail}); const repo=createMySqlSubmissionRepository({getPool:()=>db.pool});
    await assert.rejects(submit(repo),is(503));
    assert.equal(db.state.submissions.size,0); assert.equal(db.state.events.length,0); assert.ok(db.calls.includes('ROLLBACK'));
  }
});
test('审核发布：全体新增与私人结果含理由同事务，重放不再次发布', async () => {
  const db=dbFixture(); const repo=createMySqlSubmissionRepository({getPool:()=>db.pool});
  const {id}=await submit(repo); const result=await repo.reviewMySqlSubmission(id,'approved','审核合格，contact private@example.test','admin');
  assert.equal(db.state.sites.length,3); assert.equal(db.state.events.length,3);
  const publicEvent=db.state.events.find(e=>e.sql.includes("'site', 'public'"));
  assert.ok(publicEvent); assert.match(publicEvent.values[3], /Example/); assert.match(publicEvent.values[3], /https:\/\/new.test\//); assert.ok(!JSON.stringify(publicEvent).includes('private@example.test'));
  const privateEvent=db.state.events.at(-1); assert.equal(privateEvent.values[2],owner); assert.match(privateEvent.values[6],/审核合格/);
  await repo.reviewMySqlSubmission(id,'approved','审核合格，contact private@example.test','admin');
  assert.equal(db.state.events.length,3);
  // 删除后审核记录保留 approved，不会重发站点。
  db.state.sites=db.state.sites.filter(s=>s.id!==result.publishedSiteId);
  await repo.reviewMySqlSubmission(id,'approved','审核合格，contact private@example.test','admin');
  assert.equal(db.state.sites.length,2);
});
test('审核结果事件失败，站点、状态及全体事件一起回滚', async () => {
  let failing=false; const db=dbFixture({fail:sql=>failing && sql.startsWith('INSERT INTO nav_notifications') && sql.includes("'submission', 'private'")});
  const repo=createMySqlSubmissionRepository({getPool:()=>db.pool}); const {id}=await submit(repo); failing=true;
  await assert.rejects(repo.reviewMySqlSubmission(id,'approved','ok','admin'),is(503));
  assert.equal(db.state.submissions.get(id).status,'pending'); assert.equal(db.state.sites.length,2); assert.equal(db.state.events.length,1);
});
test('驳回只发私人事件，历史 NULL owner 审核不认领、不发私人事件', async () => {
  const db=dbFixture(); const repo=createMySqlSubmissionRepository({getPool:()=>db.pool});
  const {id}=await submit(repo); await repo.reviewMySqlSubmission(id,'rejected','资料不完整','admin');
  assert.equal(db.state.events.length,2); assert.equal(db.state.events.at(-1).values[6],'资料不完整'); assert.equal(db.state.sites.length,2);
  const second=await submit(repo); db.state.submissions.get(second.id).user_id=null; const count=db.state.events.length;
  await repo.reviewMySqlSubmission(second.id,'rejected','旧匿名','admin'); assert.equal(db.state.events.length,count);
});
test('后台新增写公开通知；删除清理个人记录并同事务通知', async () => {
  const db=dbFixture(); let invalidated=0;
  const store=createContentStore({getPool:()=>db.pool,driver:()=> 'mysql',invalidate:()=>invalidated++});
  const result=await store.write('POST',{kind:'sites',item:{name:'New',slug:'new',url:'https://new.test/',category:'ai',description:'',tags:[],sortOrder:2}});
  assert.match(db.state.events[0].values[1],/^site:created:/); assert.equal(db.state.sites.length,3);
  const old=(await store.list('sites')).items.find(s=>s.id==='old');
  await store.write('DELETE',{kind:'sites',id:old.id,revision:old.revision});
  assert.equal(db.state.records.length,0); assert.equal(db.state.events.at(-1).values[1],'site:deleted:old'); assert.equal(db.state.events.at(-1).values[3], '已移除站点：Old\nhttps://old.test/'); assert.equal(invalidated,2);
  assert.ok(db.state.sites.some(s=>s.id===result.id));
});
test('后台删除事件失败不得删站点/收藏，且不失效缓存', async () => {
  const db=dbFixture({fail:sql=>sql.startsWith('INSERT INTO nav_notifications')}); let invalidated=0;
  const store=createContentStore({getPool:()=>db.pool,driver:()=> 'mysql',invalidate:()=>invalidated++});
  const old=(await store.list('sites')).items.find(s=>s.id==='old');
  await assert.rejects(store.write('DELETE',{kind:'sites',id:old.id,revision:old.revision}),is(503));
  assert.equal(db.state.sites.length,2); assert.equal(db.state.records.length,1); assert.equal(invalidated,0);
});
test('删除 content API 和公告 CRUD 先管理员鉴权', async () => {
  const previous=process.env.ADMIN_TOKEN; process.env.ADMIN_TOKEN='x'.repeat(32);
  try {
    const request=()=>new Request('https://test/api/admin/content',{method:'DELETE',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal((await createContentHandler({write:()=>assert.fail('unauthorized write')})(request())).status,401);
    assert.equal((await createAnnouncementHandler({write:()=>assert.fail('unauthorized write')})(request())).status,401);
  } finally { if(previous===undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN=previous; }
});
test('纯事件 helper 不投递匿名、站点事件不含提交字段', async () => {
  const db=dbFixture(); await writeSubmissionNotification(db.c,null,randomUUID(),'rejected','Example','https://example.test/','secret'); assert.equal(db.state.events.length,0);
  await writeSiteNotification(db.c,'site-id','deleted','已删除测试站点','https://deleted.test/'); const event=db.state.events[0];
  assert.equal(event.values[3], '已移除站点：已删除测试站点\nhttps://deleted.test/');
  assert.ok(!event.sql.includes('submission_id')); assert.ok(!event.sql.includes('reason'));
});
test('公告输入校验与 seed 明确失败', async () => {
  assert.equal(validateAnnouncement({title:' 公告 ',body:' 内容 '},'POST').body,'内容');
  for(const value of [{title:'',body:'x'},{title:'x',body:'x',recipient_user_id:owner},{id:'x',title:'x',body:'x'}]) assert.throws(()=>validateAnnouncement(value,'PUT'),is(400));
  const store=createNotificationStore({driver:()=> 'seed'});
  await assert.rejects(store.list({kind:'all',page:1,pageSize:20},null),is(503));
  await assert.rejects(store.write('POST',{title:'x',body:'y'}),is(503));
});
test('通知接口匿名 all 与 submission401，返回固定分页契约', async () => {
  const calls=[];
  const handler=createNotificationHandler({getAccountUser:async()=>null,requireUser:async()=>{throw new HttpError(401,'USER_UNAUTHORIZED','请登录');},store:{list:async(q,id)=>{calls.push({q,id});return {items:[],total:0,page:q.page,pageSize:q.pageSize};}}});
  const res=await handler(new Request('https://test/api/notifications?page=2&pageSize=3'));
  assert.deepEqual(await res.json(),{data:{items:[],total:0,page:2,pageSize:3,user:null}}); assert.equal(calls[0].id,null);
  assert.equal((await handler(new Request('https://test/api/notifications?kind=submission'))).status,401); assert.equal(calls.length,1);
});
test('列表两次 SQL 都带 visibility，参数分页；只映射契约字段', async () => {
  const calls=[]; const c={async query(sql,values){calls.push({sql,values}); if(sql.startsWith('SET'))return [[]]; if(sql.includes('COUNT'))return [[{total:1}]];return [[{id:'1',kind:'site',title:'x',body:'y',created_at:new Date('2026-09-07T00:00:00Z'),reason:'secret',submission_id:'secret',payload:{email:'secret'}}]];},async beginTransaction(){},async commit(){},release(){}};
  const store=createNotificationStore({driver:()=> 'mysql',getPool:()=>({getConnection:async()=>c})});
  const result=await store.list({kind:'all',page:2,pageSize:4},null);
  assert.equal(result.total,1); assert.ok(!JSON.stringify(result).includes('secret'));
  const selects=calls.filter(c=>c.sql.startsWith('SELECT')); assert.equal(selects.length,2);
  for(const q of selects)assert.match(q.sql,/visibility = 'public'.*recipient_user_id IS NULL/);
  assert.deepEqual(selects[1].values,[4,4]);
});
test('公告同id同内容POST重放；异内容409；PUT/DELETE锁后校验revision', async () => {
  const records=new Map(); const calls=[]; let clock=0;
  const c={async query(sql,v=[]){calls.push(sql); if(sql.startsWith('SET'))return [[]];
    if(sql.startsWith('INSERT')){if(records.has(v[0]))throw Object.assign(new Error(),{code:'ER_DUP_ENTRY'});records.set(v[0],{id:v[0],title:v[2],body:v[3],createdAt:++clock});return [{}];}
    if(sql.startsWith('SELECT'))return [records.has(v[0])?[{...records.get(v[0])}]:[]];
    if(sql.startsWith('UPDATE')){records.set(v[2],{...records.get(v[2]),title:v[0],body:v[1]});return [{}];}
    if(sql.startsWith('DELETE')){records.delete(v[0]);return [{}];}assert.fail(sql);},async beginTransaction(){},async commit(){},async rollback(){calls.push('ROLLBACK');},release(){}};
  const store=createNotificationStore({driver:()=> 'mysql',getPool:()=>({getConnection:async()=>c})});
  const {id}=await store.write('POST',{title:'标题',body:'正文'});
  const original={...records.get(id)};
  assert.deepEqual(await store.write('POST',{id,title:'标题',body:'正文'}),{id});
  assert.deepEqual(records.get(id),original); assert.equal(clock,1);
  await assert.rejects(store.write('POST',{id,title:'重复',body:'正文'}),is(409));
  await assert.rejects(store.write('POST',{id,title:'标题',body:'不同'}),is(409));
  const revision=announcementRevision(id,'标题','正文');
  await store.write('PUT',{id,title:'改',body:'新正文',revision}); assert.equal(records.get(id).body,'新正文');
  const updated={...records.get(id)};
  await assert.rejects(store.write('PUT',{id,title:'覆盖',body:'旧版本',revision}),is(409));
  await assert.rejects(store.write('DELETE',{id,revision}),is(409));
  assert.deepEqual(records.get(id),updated);
  const current=announcementRevision(id,'改','新正文');
  await store.write('DELETE',{id,revision:current}); assert.equal(records.size,0);
  await assert.rejects(store.write('PUT',{id,title:'x',body:'y',revision:current}),is(404));
  await assert.rejects(store.write('DELETE',{id,revision:current}),is(404));
  assert.ok(calls.some(sql=>sql.includes("kind = 'announcement' AND visibility = 'public' AND recipient_user_id IS NULL FOR UPDATE")));
  const writes=calls.filter(sql=>sql.startsWith('UPDATE')||sql.startsWith('DELETE'));
  assert.equal(writes.length,2);
  for(const sql of writes)assert.match(sql,/kind = 'announcement' AND visibility = 'public' AND recipient_user_id IS NULL/);
});
test('revision为id/title/body的SHA256，PUT/DELETE拒绝缺失、32位、大写或非字符串', () => {
  const id=randomUUID(); const revision=announcementRevision(id,'标题','正文');
  assert.match(revision,/^[a-f0-9]{64}$/);
  assert.equal(revision,announcementRevision(id,'标题','正文'));
  for(const args of [[randomUUID(),'标题','正文'],[id,'标题变化','正文'],[id,'标题','正文变化']]) assert.notEqual(revision,announcementRevision(...args));
  assert.notEqual(announcementRevision(id,'a','bc'),announcementRevision(id,'ab','c'));
  for(const method of ['PUT','DELETE']) {
    for(const invalid of [undefined,null,32,'a'.repeat(32),'a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'g'.repeat(64)]) {
      assert.throws(()=>validateAnnouncement({id,...(method==='PUT'?{title:'x',body:'y'}:{}),revision:invalid},method),e=>e.status===400&&e.code==='INVALID_REVISION');
    }
    assert.equal(validateAnnouncement({id,...(method==='PUT'?{title:'x',body:'y'}:{}),revision},method).revision,revision);
  }
});
test('公告列表返回revision，非公告不返回；发布时间不参与版本', async () => {
  const id=randomUUID();
  const rows=[{id,kind:'announcement',title:'标题',body:'正文',created_at:new Date()}, {id:'site',kind:'site',title:'站点',body:'站点正文',created_at:new Date()}];
  const c={async query(sql){if(sql.startsWith('SET'))return [[]];if(sql.includes('COUNT'))return [[{total:2}]];return [rows];},async beginTransaction(){},async commit(){},release(){}};
  const store=createNotificationStore({driver:()=> 'mysql',getPool:()=>({getConnection:async()=>c})});
  const result=await store.list({kind:'all',page:1,pageSize:20},null);
  assert.equal(result.items[0].revision,announcementRevision(id,'标题','正文'));
  assert.ok(!Object.hasOwn(result.items[1],'revision'));
  rows[0].created_at=new Date('2020-01-01');
  assert.equal((await store.list({kind:'announcement',page:1,pageSize:20},null)).items[0].revision,result.items[0].revision);
});
test('同id占用者不是公开公告时不允许POST重放或PUT/DELETE越权', async () => {
  const writes=[];
  const c={async query(sql){if(sql.startsWith('SET'))return [[]];if(sql.startsWith('INSERT'))throw Object.assign(new Error(),{code:'ER_DUP_ENTRY'});
    if(sql.startsWith('SELECT')){assert.match(sql,/kind = 'announcement' AND visibility = 'public' AND recipient_user_id IS NULL FOR UPDATE/);return [[]];}
    writes.push(sql);assert.fail('不得修改非公告记录');},async beginTransaction(){},async commit(){},async rollback(){},release(){}};
  const store=createNotificationStore({driver:()=> 'mysql',getPool:()=>({getConnection:async()=>c})});
  const id=randomUUID(),revision=announcementRevision(id,'x','y');
  await assert.rejects(store.write('POST',{id,title:'x',body:'y'}),is(409));
  await assert.rejects(store.write('PUT',{id,title:'x',body:'y',revision}),is(404));
  await assert.rejects(store.write('DELETE',{id,revision}),is(404));
  assert.equal(writes.length,0);
});
test('迁移只增量，二次运行不重复 ALTER，不更新匿名 owner', async () => {
  let added=false; const calls=[];
  const c={async query(sql){calls.push(sql);
    if(sql.includes('GET_LOCK'))return [[{acquired:1}]];if(sql.includes('RELEASE_LOCK'))return [[{released:1}]];
    if(sql.includes('information_schema.TABLES'))return [[...['nav_users','nav_sites','nav_user_records','nav_submissions'].map(TABLE_NAME=>({TABLE_NAME,ENGINE:'InnoDB'}))]];
    if(sql.includes('information_schema.COLUMNS')&&sql.includes("TABLE_NAME = 'nav_submissions'"))return [added?[{COLUMN_NAME:'user_id',COLUMN_TYPE:'char(36)',IS_NULLABLE:'YES',COLLATION_NAME:'ascii_bin'}]:[]];
    if(sql.startsWith('ALTER')){added=true;return [{}];}
    if(sql.startsWith('CREATE'))return [{}];
    if(sql.includes('information_schema.COLUMNS'))return [['id','event_key','kind','visibility','recipient_user_id','title','body','status','reason','site_id','submission_id','created_at'].map(COLUMN_NAME=>({COLUMN_NAME}))];
    if(sql.includes('information_schema.STATISTICS'))return [[{INDEX_NAME:'event_key',NON_UNIQUE:0,COLUMN_NAME:'event_key',SEQ_IN_INDEX:1}]];
    assert.fail(sql);},destroy(){}};
  await migrateNotifications(c);await migrateNotifications(c);
  assert.equal(calls.filter(sql=>sql.startsWith('ALTER')).length,1);
  assert.ok(!calls.some(sql=>/^(UPDATE|DELETE|DROP|TRUNCATE)/.test(sql)));
});

test('公告 handler 契约、JSON格式、重复查询与超长流明确报错', async () => {
  const previous=process.env.ADMIN_TOKEN; const token='t'.repeat(32); process.env.ADMIN_TOKEN=token;
  const store={async list(q,user){assert.equal(user,null);return {items:[],total:0,page:q.page,pageSize:q.pageSize};},async write(method,value){return {id:validateAnnouncement(value,method).id};}};
  const handle=createAnnouncementHandler(store);
  const request=(method,body,headers={})=>new Request('https://test/api/admin/announcements',{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},...(body===undefined?{}:{body})});
  try {
    const result=await handle(request('GET'));
    assert.deepEqual(await result.json(),{data:{items:[],total:0,page:1,pageSize:20}});
    assert.equal((await handle(request('POST','{invalid'))).status,400);
    assert.equal((await handle(request('POST','{}',{'content-type':'text/plain'}))).status,415);
    assert.equal((await handle(request('POST',JSON.stringify({title:'x',body:'x'.repeat(17000)})))).status,413);
    assert.equal((await handle(request('PATCH','{}'))).status,405);
    assert.equal((await handle(new Request('https://test/api/admin/announcements?page=1&page=2',{headers:{authorization:`Bearer ${token}`}}))).status,400);
    assert.equal((await handle(request('DELETE',JSON.stringify({id:randomUUID(),revision:'a'.repeat(64)})))).status,200);
  } finally { if(previous===undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN=previous; }
});
test('公告写入失败回滚，驱动异常脱敏；rollback失败销毁连接', async () => {
  for(const rollbackFailure of [false,true]) {
    const calls=[];
    const c={async query(sql){if(sql.startsWith('SET'))return [[]];throw new Error('password=secret');},async beginTransaction(){},async commit(){assert.fail('must not commit');},async rollback(){calls.push('rollback');if(rollbackFailure)throw new Error();},release(){calls.push('release');},destroy(){calls.push('destroy');}};
    const store=createNotificationStore({driver:()=> 'mysql',getPool:()=>({getConnection:async()=>c})});
    await assert.rejects(store.write('POST',{title:'公告',body:'正文'}),e=>e.status===503&&!e.message.includes('secret'));
    assert.deepEqual(calls,['rollback',rollbackFailure?'destroy':'release']);
  }
});
test('迁移不接受非InnoDB或缺失基础表，不执行DDL', async () => {
  const calls=[];
  const c={async query(sql){calls.push(sql);if(sql.includes('GET_LOCK'))return [[{acquired:1}]];if(sql.includes('RELEASE_LOCK'))return [[{released:1}]];return [[{TABLE_NAME:'nav_users',ENGINE:'MyISAM'}]];}};
  await assert.rejects(migrateNotifications(c),/InnoDB/);
  assert.ok(!calls.some(s=>/^(ALTER|CREATE|UPDATE|DELETE)/.test(s)));
});
