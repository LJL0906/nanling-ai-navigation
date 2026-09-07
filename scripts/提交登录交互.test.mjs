import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createSubmissionAuth } from '../src/scripts/submission-auth.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(check = async () => {}) {
  const events = [];
  let checks = 0;
  const auth = createSubmissionAuth({
    check: () => { checks++; return check(); },
    open: () => events.push(['open']),
    login: () => events.push(['login']),
    loading: value => events.push(['loading', value]),
    error: error => events.push(['error', error]),
  });
  return { auth, events, get checks() { return checks; } };
}

const unauthorizedError = () => Object.assign(new Error('请先登录'), { status: 401 });

for (const reason of ['login', 'register']) {
  test(`未登录引导登录，${reason} 成功重新检查并仅续开一次`, async () => {
    const error = unauthorizedError();
    let authenticated = false;
    const state = setup(async () => { if (!authenticated) throw error; });
    await state.auth.open();
    assert.equal(state.checks, 1);
    assert.deepEqual(state.events, [
      ['loading', true], ['error', error], ['login'], ['loading', false],
    ]);

    state.auth.accountChanged('profile');
    state.auth.accountChanged(undefined);
    assert.equal(state.checks, 1, '无关账号事件不能消费待续开状态');
    authenticated = true;
    state.auth.accountChanged(reason);
    await setImmediate(); // accountChanged 内部以 void 调用 open，等待其微任务完成。
    assert.equal(state.checks, 2);
    assert.deepEqual(state.events.slice(4), [['loading', true], ['open'], ['loading', false]]);
    const completed = [...state.events];
    state.auth.accountChanged('login');
    state.auth.accountChanged('register');
    await setImmediate();
    assert.equal(state.checks, 2);
    assert.deepEqual(state.events, completed);
  });
}

test('没有待续开请求时，登录和注册事件不主动弹出提交框', async () => {
  const state = setup();
  state.auth.accountChanged('login');
  state.auth.accountChanged('register');
  await setImmediate();
  assert.equal(state.checks, 0);
  assert.deepEqual(state.events, []);
});

test('外部 requestLogin 可供提交接口 401 恢复，登录后重新检查', async () => {
  const state = setup();
  state.auth.requestLogin();
  assert.deepEqual(state.events, [['login']]);
  assert.equal(state.checks, 0);
  state.auth.accountChanged('login');
  await setImmediate();
  assert.equal(state.checks, 1);
  assert.deepEqual(state.events, [['login'], ['loading', true], ['open'], ['loading', false]]);
});

test('检查期间合并连点，loading 立即开始且只在完成时恢复', async () => {
  const pending = deferred();
  const state = setup(() => pending.promise);
  const first = state.auth.open();
  const duplicates = Array.from({ length: 8 }, () => state.auth.open());
  await Promise.all(duplicates);
  assert.equal(state.checks, 1);
  assert.deepEqual(state.events, [['loading', true]]);
  pending.resolve();
  await first;
  assert.deepEqual(state.events, [['loading', true], ['open'], ['loading', false]]);

  await state.auth.open();
  assert.equal(state.checks, 2, '完成后应解除连点锁');
  assert.deepEqual(state.events.slice(3), [['loading', true], ['open'], ['loading', false]]);
});

for (const error of [new TypeError('Failed to fetch'), Object.assign(new Error('服务不可用'), { status: 503 })]) {
  test(`${error.message}：不唤起登录、不因账号事件续开，手动重试可恢复`, async () => {
    let fail = true;
    const state = setup(async () => { if (fail) throw error; });
    await state.auth.open();
    assert.deepEqual(state.events, [['loading', true], ['error', error], ['loading', false]]);
    state.auth.accountChanged('login');
    state.auth.accountChanged('register');
    await setImmediate();
    assert.equal(state.checks, 1);
    fail = false;
    await state.auth.open();
    assert.equal(state.checks, 2);
    assert.deepEqual(state.events.slice(3), [['loading', true], ['open'], ['loading', false]]);
  });
}

for (const outcome of ['success', '401', 'network']) {
  test(`logout 中断正在检查：忽略迟到的 ${outcome}，恢复 loading 并允许重试`, async () => {
    const pending = deferred();
    let next = pending.promise;
    const state = setup(() => next);
    const opening = state.auth.open();
    state.auth.accountChanged('logout');
    if (outcome === 'success') pending.resolve();
    else pending.reject(outcome === '401' ? unauthorizedError() : new TypeError('Failed to fetch'));
    await opening;
    assert.deepEqual(state.events, [['loading', true], ['loading', false]]);
    state.auth.accountChanged('login');
    await setImmediate();
    assert.equal(state.checks, 1);

    next = Promise.resolve();
    await state.auth.open();
    assert.equal(state.checks, 2);
    assert.deepEqual(state.events.slice(2), [['loading', true], ['open'], ['loading', false]]);
  });
}

test('logout 清除已经请求登录的续开意图', async () => {
  const state = setup();
  state.auth.requestLogin();
  state.auth.accountChanged('logout');
  state.auth.accountChanged('login');
  state.auth.accountChanged('register');
  await setImmediate();
  assert.equal(state.checks, 0);
  assert.deepEqual(state.events, [['login']]);
});

for (const outcome of ['success', '401', 'network']) {
  test(`dispose 后忽略迟到的 ${outcome}，不再更新界面或弹窗`, async () => {
    const pending = deferred();
    const state = setup(() => pending.promise);
    const opening = state.auth.open();
    state.auth.dispose();
    state.auth.dispose();
    if (outcome === 'success') pending.resolve();
    else pending.reject(outcome === '401' ? unauthorizedError() : new TypeError('Failed to fetch'));
    await opening;
    await state.auth.open();
    state.auth.requestLogin();
    state.auth.accountChanged('login');
    state.auth.accountChanged('register');
    await setImmediate();
    assert.equal(state.checks, 1);
    assert.deepEqual(state.events, [['loading', true]], '销毁后不能调用包括 loading 在内的界面回调');
  });
}

test('尚未检查即 dispose，所有入口均无副作用', async () => {
  const state = setup();
  state.auth.dispose();
  await state.auth.open();
  state.auth.requestLogin();
  state.auth.accountChanged('login');
  await setImmediate();
  assert.equal(state.checks, 0);
  assert.deepEqual(state.events, []);
});

test('dispose 清除已有登录引导，登录完成后也不续开', async () => {
  const state = setup();
  state.auth.requestLogin();
  state.auth.dispose();
  state.auth.accountChanged('login');
  state.auth.accountChanged('register');
  await setImmediate();
  assert.equal(state.checks, 0);
  assert.deepEqual(state.events, [['login']]);
});

test('401 识别仅接受数值 status=401，非错误值和其他状态均安全返回 false', () => {
  const { auth } = setup();
  for (const error of [unauthorizedError(), { status: 401 }]) {
    assert.equal(auth.unauthorized(error), true);
  }
  for (const error of [
    null, undefined, false, 401, '401', {}, new Error('401'),
    { status: '401' }, { status: 403 }, { status: 500 },
    { code: 401 }, { response: { status: 401 } },
  ]) {
    assert.equal(auth.unauthorized(error), false);
  }
});

test('页面接线：打开及发送前查会话，401在恢复控件后唤起登录，保留输入并清理监听', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/scripts/site-submission.ts', import.meta.url), 'utf8');
  const component = await readFile(new URL('../src/components/layout/SiteSubmission.astro', import.meta.url), 'utf8');
  assert.match(source, /check: checkAccount/);
  assert.match(source, /fetchSubmissionJson\('\/api\/account\/session', \{ credentials: 'same-origin', cache: 'no-store' \}, 10_000\)/);
  const submit = source.slice(source.indexOf("form.addEventListener('submit'"));
  assert.ok(submit.indexOf('await checkAccount()') < submit.indexOf('await readFile(file)'));
  assert.ok(submit.indexOf('await checkAccount()') < submit.indexOf("fetchSubmissionJson('/api/submissions'"));
  assert.ok(submit.indexOf('busy = false') < submit.indexOf('auth.requestLogin()'));
  assert.match(submit, /needsLogin = auth\.unauthorized\(error\)/);
  assert.ok(!submit.slice(submit.indexOf('} catch (error)')).includes('form.reset()'));
  assert.match(source, /document\.dispatchEvent\(new CustomEvent\('nav:auth-required'\)\)/);
  assert.match(source, /auth\.accountChanged\(reason\)/);
  assert.match(source, /auth\.dispose\(\)/);
  assert.match(source, /removeEventListener\('nav:account-changed', accountChanged\)/);
  assert.match(component, /data-submission-entry-message role="status"/);
  assert.match(component, /登录后提交/);
});
