import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createConnection } from 'mysql2/promise';
import { getMySqlOptions } from '../src/server/database-config.ts';
import { toConnectionOptions } from './管理数据库.mjs';
if (process.argv[2] !== '--apply' || process.argv.length !== 3) {
  console.log('真实数据库验收会创建两个临时账号，结束后按ID删除。请加 --apply 明确执行。');
  process.exit(0);
}
const suffix = randomBytes(6).toString('hex');
const usernames = [`verify_a_${suffix}`,`verify_b_${suffix}`];
const password = `Test!${randomBytes(20).toString('hex')}`;
let db, server;
const ids = [];
try {
  db = await createConnection(toConnectionOptions(getMySqlOptions()));
  const [sites] = await db.query('SELECT id FROM nav_sites ORDER BY id LIMIT 105');
  assert.equal(sites.length,105);
  const listener = createServer();
  await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath,['dist/server/entry.mjs'],{env:{...process.env,NAV_STORAGE:'mysql',HOST:'127.0.0.1',PORT:String(port)},stdio:'ignore',windowsHide:true});
  let ready = false;
  for(let i=0;i<100;i++) {
    if(server.exitCode !== null) throw new Error('启动失败');
    try { const r = await fetch(`${base}/api/account/session`); if(r.ok) {ready=true;break;} } catch {}
    await new Promise(resolve => setTimeout(resolve,200));
  }
  assert.ok(ready,'服务启动');
  const call = (path,method='GET',body,cookie='',origin=base) => fetch(base+path,{method,headers:{...(method !== 'GET' ? {'Content-Type':'application/json',Origin:origin}:{}),...(cookie?{Cookie:cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data = async response => { assert.equal(response.status,200); return (await response.json()).data; };
  assert.equal((await call('/api/personal')).status,401);
  assert.equal((await call('/api/submissions','POST',{})).status,401, '未登录提交必须先通过账号鉴权');
  assert.equal((await call('/api/account/register','POST',{username:usernames[0],password},'', 'https://evil.test')).status,403);
  const register = await call('/api/account/register','POST',{username:usernames[0],password});
  assert.ok([200,201].includes(register.status));
  const cookie = register.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/i); assert.match(cookie,/SameSite=/i);
  const sessionA = cookie.split(';')[0];
  assert.equal((await call('/api/submissions','POST',{},sessionA)).status,400, '登录后提交进入内容校验');
  let [users] = await db.execute('SELECT id,password_hash FROM nav_users WHERE username=?',[usernames[0]]);
  assert.equal(users.length,1); ids.push(users[0].id);
  assert.notEqual(users[0].password_hash,password);
  const [sessions] = await db.execute('SELECT token_hash FROM nav_user_sessions WHERE user_id=?',[ids[0]]);
  assert.equal(sessions.length,1);
  assert.equal(sessions[0].token_hash,createHash('sha256').update(sessionA.slice(sessionA.indexOf('=')+1)).digest('hex'));
  assert.equal((await call('/api/account/register','POST',{username:usernames[0],password})).status,409);
  const second = await call('/api/account/register','POST',{username:usernames[1],password});
  assert.ok([200,201].includes(second.status));
  const sessionB = second.headers.get('set-cookie').split(';')[0];
  [users] = await db.execute('SELECT id FROM nav_users WHERE username=?',[usernames[1]]); ids.push(users[0].id);
  assert.equal((await call('/api/account/session','POST',{username:usernames[0],password:'wrong-password'})).status,401);
  const mutate = operation => call('/api/personal','POST',operation,sessionA).then(data);
  let state = await mutate({action:'favorite',siteId:sites[0].id,selected:true});
  assert.equal(state.favorites.length,1);
  await mutate({action:'favorite',siteId:sites[0].id,selected:true});
  assert.equal((await data(await call('/api/personal','GET',undefined,sessionA))).favorites.length,1);
  assert.deepEqual(await data(await call('/api/personal','GET',undefined,sessionB)),{favorites:[],history:[]});
  const [stored] = await db.execute("SELECT site_id FROM nav_user_records WHERE user_id=? AND kind='favorites'",[ids[0]]);
  assert.equal(stored[0].site_id,sites[0].id);
  assert.equal((await call('/api/personal','POST',{action:'clear',kind:'favorites'},sessionA,'https://evil.test')).status,403);
  assert.equal((await call('/api/personal','POST',{action:'favorite',siteId:'site_missingtest',selected:true},sessionA)).status,404);
  await mutate({action:'favorite',siteId:sites[0].id,selected:false});
  assert.equal((await data(await call('/api/personal','GET',undefined,sessionA))).favorites.length,0);
  const imported = {action:'import',favorites:[{siteId:sites[1].id,updatedAt:'2020-01-01T00:00:00.000Z'}],history:sites.slice(0,100).map((site,i)=>({siteId:site.id,updatedAt:new Date(Date.UTC(2020,0,1,0,0,i)).toISOString(),visitType:'detail'}))};
  await mutate(imported); state = await mutate(imported);
  assert.equal(state.favorites.length,1); assert.equal(state.history.length,100);
  state = await mutate({action:'visit',siteId:sites[100].id,visitType:'external'});
  assert.equal(state.history.length,100); assert.equal(state.history[0].siteId,sites[100].id);
  assert.ok(!state.history.some(r=>r.siteId===sites[0].id));
  state = await mutate({action:'remove',kind:'history',siteId:sites[100].id});
  assert.equal(state.history.length,99);
  // 新登录会话模拟另一设备，读取同一账号收藏。
  const login = await call('/api/account/session','POST',{username:usernames[0],password});
  assert.equal(login.status,200);
  const otherDevice = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await data(await call('/api/personal','GET',undefined,otherDevice))).favorites[0].siteId,sites[1].id);
  state = await mutate({action:'clear',kind:'history'}); assert.equal(state.history.length,0); assert.equal(state.favorites.length,1);
  state = await mutate({action:'clear',kind:'favorites'}); assert.equal(state.favorites.length,0);
  assert.equal((await call('/api/account/session','DELETE',undefined,sessionA)).status,200);
  assert.equal((await call('/api/personal','GET',undefined,sessionA)).status,401);
  assert.equal((await call('/api/account/session','GET')).headers.get('cache-control'),'no-store');
  console.log('真实MySQL验收通过：注册/重复账号/密码摘要/会话摘要/登录/退出/鉴权/跨源阻断/用户隔离/收藏增删回读/迁移幂等/访问历史100条上限/清空/跨会话同步。');
} catch (error) {
  console.error('真实账号验收失败：',error instanceof assert.AssertionError ? error.message : '请检查服务、迁移和数据库配置（不输出凭据或驱动错误）。');
  process.exitCode=1;
} finally {
  if(server && server.exitCode === null) { server.kill(); await new Promise(resolve=>server.once('exit',resolve)); }
  if(db) {
    // 只删除本次随机用户名；包括注册成功但断言尚未收集ID的情况。
    try {
      for (const username of usernames) await db.execute('DELETE FROM nav_users WHERE username=?',[username]);
      console.log('本次两个临时账号及其会话、个人记录已清理。');
    } catch { console.error('临时账号清理失败，请按验收脚本本次随机前缀人工核查。'); process.exitCode=1; }
    await db.end();
  }
}


