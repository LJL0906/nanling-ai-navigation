/** 真实MySQL验收：显式运行，使用随机编号，finally仅清理本次测试记录。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSubmissionHandler } from '../src/server/site-submissions.ts';
import { createSubmissionReviewHandler } from '../src/server/submission-review.ts';
import { getSubmissionPool } from '../src/server/mysql-submissions.ts';
import { decodeNavigationRows } from '../src/server/mysql-reader.ts';

async function main() {
  if (!process.argv.includes('--run')) throw new Error('使用 --run 执行真实数据库验收');
  const pool = getSubmissionPool();
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const publishedIds = ids.map(id => `submitted-${id}`);
  const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const oldToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = token;
  let passed = false;
  try {
    const [categories] = await pool.query('SELECT id FROM nav_categories ORDER BY sort_order LIMIT 1');
    assert.ok(categories[0]?.id, '数据库须已有分类');
    const submit = createSubmissionHandler({getCategories:async()=>categories});
    const review = createSubmissionReviewHandler();
    const payload = { categoryId:categories[0].id, customCategory:'', name:'数据库验收临时站点',
      url:`https://example.invalid/${ids[0]}`, iconUrl:'', iconData:'', remark:'私有审核备注，不应公开' };
    const request = (id, patch={}) => new Request('https://localhost/api/submissions', {method:'POST',
      headers:{Origin:'https://localhost','Content-Type':'application/json','Idempotency-Key':id},body:JSON.stringify({...payload,...patch})});
    const audit = (id,status) => review(new Request('https://localhost/api/admin/submissions',{method:'PATCH',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({id,status,reason:'自动验收临时记录'})}));
    const results = await Promise.all([submit(request(ids[0]),'mysql-acceptance'),submit(request(ids[0]),'mysql-acceptance')]);
    for(const result of results) {assert.equal(result.status,201); assert.equal((await result.json()).data.id,ids[0]);}
    const [pending] = await pool.execute('SELECT status,payload FROM nav_submissions WHERE id=?',[ids[0]]);
    assert.equal(pending.length,1); assert.equal(pending[0].status,'pending');
    const list = await review(new Request('https://localhost/api/admin/submissions?status=pending',{headers:{Authorization:`Bearer ${token}`}}));
    assert.equal(list.status,200); assert.ok((await list.json()).data.items.some(item=>item.id===ids[0] && item.remark===payload.remark));
    assert.equal((await audit(ids[0],'approved')).status,200);
    assert.equal((await audit(ids[0],'approved')).status,200);
    const [sites] = await pool.execute('SELECT payload FROM nav_sites WHERE id=?',[publishedIds[0]]);
    assert.equal(sites.length,1); assert.ok(!JSON.stringify(sites[0].payload).includes(payload.remark));
    assert.equal((await submit(request(ids[1]),'mysql-acceptance')).status,201);
    assert.equal((await audit(ids[1],'approved')).status,409);
    const [duplicate] = await pool.execute('SELECT status FROM nav_submissions WHERE id=?',[ids[1]]);
    assert.equal(duplicate[0].status,'pending');
    assert.equal((await audit(ids[1],'rejected')).status,200);
    assert.equal((await submit(request(ids[2],{url:`https://example.invalid/${ids[2]}`}), 'mysql-acceptance')).status,201);
    assert.equal((await audit(ids[2],'rejected')).status,200);
    assert.equal((await submit(request(ids[3],{categoryId:'', customCategory:`验收分类-${ids[3].slice(0,8)}`,url:`https://example.invalid/${ids[3]}`}), 'mysql-acceptance')).status,201);
    assert.equal((await audit(ids[3],'approved')).status,200);
    const [rawCategories]=await pool.query('SELECT id,slug,payload FROM nav_categories');
    const [rawSites]=await pool.query('SELECT id,category_id,slug,payload FROM nav_sites');
    const navigation=decodeNavigationRows(rawCategories,rawSites);
    assert.ok(navigation.sites.some(site=>site.id===publishedIds[3]));
    passed=true;
  } finally {
    if(oldToken===undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN=oldToken;
    const connection=await pool.getConnection();
    try {
      await connection.beginTransaction();
      for(const id of publishedIds) await connection.execute('DELETE FROM nav_sites WHERE id=?',[id]);
      for(const id of publishedIds) await connection.execute('DELETE FROM nav_categories WHERE id=?',[id]);
      for(const id of ids) await connection.execute('DELETE FROM nav_submissions WHERE id=?',[id]);
      await connection.commit();
    } catch(error) {await connection.rollback();throw error;} finally {connection.release();await pool.end();}
  }
  console.log(JSON.stringify({passed, checks:['提交真实入库','并发幂等','后台待审列表与备注','通过与发布事务','重复URL回滚','拒绝不发布','自定义分类发布','导航数据回读'],testRecordsCleaned:true}));
}
main().catch(()=>{console.error('MySQL提交验收失败，请检查数据库初始化及接口状态；未输出驱动异常或密钥。');process.exitCode=1;});
