import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { HttpError } from '../src/server/http.ts';
import { ACCOUNT_COOKIE } from '../src/server/account-security.ts';

const owner = '11111111-1111-4111-8111-111111111111';
let authenticated = false;
let saves = 0;
let categoriesRead = 0;
globalThis.__submissionAuthTest = {
  requireUser: async () => {
    if (!authenticated) throw new HttpError(401, 'USER_UNAUTHORIZED', '请先登录。');
    return { id: owner, username: 'test-user' };
  },
  submit: async (_data, _key, _upload, charge, address, userId) => {
    assert.equal(userId, owner);
    assert.equal(address, 'adapter-ip');
    charge(); saves++;
    return { id: 'test-submission', status: 'pending' };
  },
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/server/site-submissions.ts')) {
    const source = specifier === './account.ts'
      ? 'export const requireUser = (...args) => globalThis.__submissionAuthTest.requireUser(...args);'
      : specifier === './mysql-submissions.ts'
        ? 'export const submitToMySql = (...args) => globalThis.__submissionAuthTest.submit(...args);' : null;
    if (source) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  }
  return next(specifier, context);
} });
const { createSubmissionHandler } = await import('../src/server/site-submissions.ts');
const payload = { categoryId: 'ai', customCategory: '', name: 'test', url: 'https://example.test/', iconUrl: '', iconData: '', remark: '备注' };
const request = (data, withSession = false) => new Request('https://example.test/api/submissions', {
  method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json',
    ...(withSession ? { Cookie: `${ACCOUNT_COOKIE}=${'a'.repeat(64)}` } : {}) }, body: JSON.stringify(data),
});
test('提交登录门禁：匿名先拦截、绑定会话用户、拒绝伪造归属、过期不保存', async () => {
  try {
    const handle = createSubmissionHandler({ getCategories: async () => { categoriesRead++; return [{ id: 'ai' }]; },
      uploadIcon: async () => { throw new Error('未授权请求不应上传'); } });
    const anonymous = await handle(request({ ...payload, iconData: 'invalid' }), 'adapter-ip');
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, 'USER_UNAUTHORIZED');
    assert.equal(categoriesRead, 0); assert.equal(saves, 0);
    authenticated = true;
    const success = await handle(request(payload, true), 'adapter-ip');
    assert.equal(success.status, 201); assert.equal(saves, 1);
    for (const field of ['userId', 'user_id', 'recipient_user_id']) {
      assert.equal((await handle(request({ ...payload, [field]: 'forged' }, true), 'adapter-ip')).status, 400);
    }
    assert.equal(saves, 1);
    authenticated = false;
    assert.equal((await handle(request(payload, true), 'adapter-ip')).status, 401);
    assert.equal(saves, 1);
  } finally { hooks.deregister(); delete globalThis.__submissionAuthTest; }
});
