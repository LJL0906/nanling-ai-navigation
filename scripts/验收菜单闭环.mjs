/** 显式 --apply 才会创建临时验收菜单；结束后删除本脚本创建的菜单，保留其他数据。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'mysql2/promise';
import { getMySqlOptions, getStorageDriver } from '../src/server/database-config.ts';
import { toConnectionOptions } from './管理数据库.mjs';
import { menuRevision } from '../src/server/menu-validation.ts';

if (process.argv.length !== 3 || process.argv[2] !== '--apply') {
  console.error('此验收会临时写入三条菜单并清理，确认后使用 --apply。'); process.exit(2);
}
assert.equal(getStorageDriver(), 'mysql', '需要 NAV_STORAGE=mysql');
const probe = createServer(); await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port = probe.address().port; await new Promise(r=>probe.close(r));
const token = randomBytes(32).toString('hex');
const server = spawn(process.execPath, ['--env-file-if-exists=.env','dist/server/entry.mjs'], {
  env:{...process.env,HOST:'127.0.0.1',PORT:String(port),ADMIN_TOKEN:token}, windowsHide:true, stdio:'ignore',
});
const base = `http://127.0.0.1:${port}`;
const auth = {authorization:`Bearer ${token}`,'content-type':'application/json'};
const tag = `smoke-${randomBytes(8).toString('hex')}`;
const ids = [`${tag}:link`,`${tag}:group`,`${tag}:child`];
const request = (path, options={}) => fetch(base+path, {...options, signal:AbortSignal.timeout(20000)});
const read = async()=> {
  const response=await request('/api/admin/menus',{headers:auth}); assert.equal(response.status,200);
  return (await response.json()).data;
};
const save = async(menus,revision)=> {
  const response=await request('/api/admin/menus',{method:'PUT',headers:auth,body:JSON.stringify({menus,revision})});
  assert.equal(response.status,200,`菜单保存应成功，实际 ${response.status}`);
  return (await response.json()).data;
};
let original;
let cleanupNeeded = false;
let database;
try {
  let ready=false;
  for(let i=0;i<80;i++){
    try {const res=await request('/api/health');if(res.ok){ready=true;break;}}catch{}
    if(server.exitCode !== null) break;
    await new Promise(r=>setTimeout(r,250));
  }
  assert.ok(ready,'临时 MySQL 服务未就绪');
  assert.equal((await request('/api/admin/menus')).status,401);
  assert.equal((await request('/api/admin/menus',{method:'PUT',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal((await request('/api/menus',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,405);
  const page=await request('/admin/menus/');assert.equal(page.status,200);
  assert.ok(!(await page.text()).includes(token));
  original = await read(); assert.equal(original.writable,true);
  const bad=structuredClone(original.menus);bad[0].href='javascript:alert(1)';bad[0].kind='link';
  assert.equal((await request('/api/admin/menus',{method:'PUT',headers:auth,body:JSON.stringify({menus:bad,revision:original.revision})})).status,400);
  const make=(id,label,location,kind,parentId,href,order,payload={})=>({id,label,location,kind,parentId,href,icon:'lucide:rocket',sortOrder:order,enabled:true,payload});
  const additions=[make(ids[0],tag+'初始链接','sidebar','link',null,'/search/',0),
    make(ids[1],tag+'分组','topbar','group',null,null,0,{description:'闭环临时验收'}),
    make(ids[2],tag+'资源','topbar','resource',ids[1],'https://example.com/',0,{description:'临时验收',target:'_blank'})];
  cleanupNeeded=true;
  let current = await save([...original.menus,...additions],original.revision);
  const visible=await request('/api/menus').then(r=>r.json());
  assert.ok(ids.every(id=>visible.data.some(m=>m.id===id)));
  let html=await request('/').then(r=>r.text());
  assert.ok(html.includes(tag+'初始链接') && html.includes(tag+'分组') && html.includes(tag+'资源'));
  assert.ok(html.includes('data-icon="lucide:rocket"'),'运行期新增图标应正常渲染');
  const sidebar=html.match(/<aside[\s\S]*?<\/aside>/)?.[0] ?? '';
  assert.ok(sidebar.indexOf(tag+'初始链接') < sidebar.indexOf('data-menu-id="/ai/"'),'默认排序应影响SSR菜单');
  assert.equal((await request('/api/admin/menus',{method:'PUT',headers:auth,body:JSON.stringify({menus:original.menus,revision:original.revision})})).status,409);
  const changed=structuredClone(current.menus);
  const link=changed.find(m=>m.id===ids[0]);link.label=tag+'已编辑';link.href='https://example.com/updated';link.payload.target='_blank';link.sortOrder=99999;
  changed.find(m=>m.id===ids[1]).enabled=false;
  current=await save(changed,current.revision);
  const hidden=await request('/api/menus').then(r=>r.json());
  assert.ok(!hidden.data.some(m=>m.id===ids[1]||m.id===ids[2]),'隐藏父项同时隐藏子项');
  html=await request('/').then(r=>r.text());
  assert.ok(html.includes(tag+'已编辑') && html.includes('https://example.com/updated'));
  assert.ok(!html.includes(tag+'分组') && !html.includes(tag+'资源'));
  const reordered=html.match(/<aside[\s\S]*?<\/aside>/)?.[0] ?? '';
  assert.ok(reordered.indexOf(tag+'已编辑') > reordered.indexOf('data-menu-id="/ai/"'));
  database=await createConnection(toConnectionOptions(getMySqlOptions()));
  const [rows]=await database.execute('SELECT label,href,sort_order FROM nav_menus WHERE id=?',[ids[0]]);
  assert.equal(rows[0].label,tag+'已编辑');assert.equal(rows[0].href,link.href);assert.equal(rows[0].sort_order,99999);
  console.log('MySQL 菜单闭环验收通过：鉴权、管理页、公开查询、新增、编辑、排序、父子显隐、动态图标、过期版本冲突及数据库回读。');
} finally {
  try {
    if(cleanupNeeded){
      const current=await read();
      const remaining=current.menus.filter(m=>!ids.includes(m.id));
      const restored=await save(remaining,current.revision);
      assert.ok(!restored.menus.some(m=>ids.includes(m.id)));
      const html=await request('/').then(r=>r.text());assert.ok(!html.includes(tag));
      if(original && menuRevision(remaining)===original.revision) assert.equal(restored.revision,original.revision);
      console.log('删除闭环验证通过；临时验收菜单已清理，其他菜单保留。');
    }
  } finally {
    await database?.end();
    server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));
  }
}
