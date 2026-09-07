import test from 'node:test';
import assert from 'node:assert/strict';
import { syncMenuSeed, runMenuSync } from './同步菜单数据.mjs';
const seed = { menus: [{ id:'home', parentId:null, location:'sidebar', kind:'link', label:'首页', href:'/', icon:'lucide:house', sortOrder:0, enabled:true, payload:{} }], settings:[{key:'site',value:{name:'测试'}}] };
function mock({existing=false, conflict=false, insertFailure=false, engine='InnoDB', lock=1}={}) {
 const calls=[];
 return {calls,
  async query(sql) {
   calls.push(sql);
   if(sql.includes('information_schema')) return [[{name:'nav_menus',engine},{name:'nav_settings',engine}]];
   if(sql.startsWith('SELECT * FROM nav_menus')) return [existing ? [{id:'home',parent_id:null,location:'sidebar',kind:'link',label:conflict?'已修改':'首页',href:'/',icon:'lucide:house',sort_order:0,enabled:1,payload:{}}] : []];
   if(sql.startsWith('SELECT * FROM nav_settings')) return [existing ? [{setting_key:'site',payload:{name:'测试'}}] : []];
   return [[]];
  },
  async execute(sql, values) {
   calls.push([sql, values]);
   if(sql.includes('GET_LOCK')) return [[{acquired:lock}]];
   if(sql.includes('RELEASE_LOCK')) return [[{released:1}]];
   if(insertFailure && sql.startsWith('INSERT')) throw new Error('模拟写入失败');
   return [{}];
  },
  async beginTransaction(){calls.push('begin');}, async commit(){calls.push('commit');}, async rollback(){calls.push('rollback');},
 };
}
test('菜单同步默认只预览，不连接数据库', async()=>{
 let connected=false;
 assert.equal(await runMenuSync([], {connect:async()=>{connected=true;},output:()=>{}}),0);
 assert.equal(connected,false);
});
test('拒绝无效参数且不连接',async()=>{
 let connected=false;
 assert.equal(await runMenuSync(['--force'],{connect:async()=>{connected=true;},errorOutput:()=>{}}),1);
 assert.equal(connected,false);
});
test('空表参数化插入，提交并释放锁', async()=>{
 const c=mock(); assert.deepEqual(await syncMenuSeed(c,seed),{inserted:true,menus:1,settings:1});
 assert.ok(c.calls.includes('commit')); assert.ok(!c.calls.includes('rollback'));
 const inserts=c.calls.filter(x=>Array.isArray(x)&&x[0].startsWith('INSERT'));
 assert.equal(inserts.length,2); assert.ok(inserts[0][0].includes('?,?,?,?,?,?,?,?,?,?'));
 assert.equal(inserts[0][1][4],'首页');
});
test('重复初始化一致时无写入',async()=>{
 const c=mock({existing:true}); assert.equal((await syncMenuSeed(c,seed)).inserted,false);
 assert.ok(!c.calls.some(x=>Array.isArray(x)&&x[0].startsWith('INSERT')));
});
test('不同数据拒绝覆盖并回滚',async()=>{
 const c=mock({existing:true,conflict:true}); await assert.rejects(syncMenuSeed(c,seed),/拒绝覆盖/);
 assert.ok(c.calls.includes('rollback')); assert.ok(!c.calls.includes('commit'));
});
test('插入失败回滚并释放锁',async()=>{
 const c=mock({insertFailure:true}); await assert.rejects(syncMenuSeed(c,seed));
 assert.ok(c.calls.includes('rollback')); assert.ok(c.calls.some(x=>Array.isArray(x)&&x[0].includes('RELEASE_LOCK')));
});
test('拒绝非事务引擎',async()=>{
 const c=mock({engine:'MyISAM'}); await assert.rejects(syncMenuSeed(c,seed),/InnoDB/); assert.ok(!c.calls.includes('begin'));
});
test('拿锁失败不建表不写入',async()=>{
 const c=mock({lock:0}); await assert.rejects(syncMenuSeed(c,seed),/初始化锁/);
 assert.equal(c.calls.length,1);
});
