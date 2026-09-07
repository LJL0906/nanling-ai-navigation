import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePersonalAction, readPersonalAction } from '../src/server/personal-validation.ts';
const stamp = '2026-09-07T00:00:00.000Z';
test('个人动作只允许明确的操作、列表、站点和布尔收藏状态', () => {
  assert.deepEqual(validatePersonalAction({action:'favorite',siteId:'site_abc',selected:true}),{action:'favorite',siteId:'site_abc',selected:true});
  for (const value of [null,[],{}, {action:'clear',kind:'users'}, {action:'favorite',siteId:'site_a',selected:'true'}, {action:'visit',siteId:'../a',visitType:'external'}, {action:'visit',siteId:'site_a',visitType:'bad'}]) assert.throws(() => validatePersonalAction(value), {status:400});
});
test('迁移去重并保留最新时间，未来时间截断', () => {
  const result = validatePersonalAction({action:'import',favorites:[{siteId:'site_a',updatedAt:'2020-01-01'}, {siteId:'site_a',updatedAt:'2099-01-01'}],history:[]},Date.parse(stamp));
  assert.deepEqual(result.favorites,[{siteId:'site_a',updatedAt:stamp}]);
});
test('拒绝超量或损坏的本地迁移记录', () => {
  for (const favorites of [[{siteId:'site_a',updatedAt:'bad'}],Array(2501).fill({siteId:'site_a',updatedAt:stamp}),[{siteId:'site_a',updatedAt:stamp,visitType:'bad'}]]) assert.throws(() => validatePersonalAction({action:'import',favorites,history:[]}),{status:400});
  assert.throws(() => validatePersonalAction({action:'import',favorites:[],history:Array(101).fill({siteId:'site_a',updatedAt:stamp})}),{status:400});
});
const request = (body,headers={}) => new Request('https://nav.test/api/personal',{method:'POST',headers:{origin:'https://nav.test','content-type':'application/json',...headers},body});
test('个人写接口要求同源及JSON，拒绝坏JSON', async () => {
  await assert.rejects(readPersonalAction(request('{}',{origin:'https://evil.test'})),{status:403});
  await assert.rejects(readPersonalAction(request('{}',{origin:''})),{status:403});
  await assert.rejects(readPersonalAction(request('{}',{'sec-fetch-site':'cross-site'})),{status:403});
  await assert.rejects(readPersonalAction(request('{}',{'content-type':'text/plain'})),{status:415});
  await assert.rejects(readPersonalAction(request('{')),{status:400});
  assert.deepEqual(await readPersonalAction(request('{"action":"clear","kind":"history"}')),{action:'clear',kind:'history'});
});
test('没有Content-Length也执行512KiB请求流限制', async () => {
  await assert.rejects(readPersonalAction(request(' '.repeat(512*1024+1))),{status:413});
});
