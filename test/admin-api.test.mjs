import test from 'node:test';
import assert from 'node:assert/strict';
import { githubClient, requestSiteUpdate, findUpdateRun, sourceRepository } from '../public/admin-api.js';

test('admin dispatches an update only to the site, without putting credentials in URLs or request bodies', async () => {
  let call;
  const api=await requestSiteUpdate({
    repository:'weather-example/example.github.io',branch:'main',token:'test-secret',requestId:'request-123',
    fetchImpl:async (url,options)=>{ call={url,options};return {ok:true,status:204}; }
  });
  assert.equal(call.url,'https://api.github.com/repos/weather-example/example.github.io/actions/workflows/update-site.yml/dispatches');
  assert.deepEqual(JSON.parse(call.options.body),{ref:'main',inputs:{request_id:'request-123'}});
  assert.equal(call.options.headers.Authorization,'Bearer test-secret');
  assert.equal(call.options.redirect,'error');
  assert.equal(call.options.body.includes('test-secret'),false);
  assert.equal(call.url.includes('test-secret'),false);
  assert.equal(typeof api,'function');
  await assert.rejects(requestSiteUpdate({repository:sourceRepository,branch:'main',requestId:'abc'}),/non configuré/);
});

test('admin follows its own request, not a simultaneous workflow run', async () => {
  const run=await findUpdateRun(async()=>({workflow_runs:[
    {id:1,display_title:'Mise à jour other'},
    {id:2,display_title:'Mise à jour mine',status:'completed',conclusion:'success'}
  ]}),'example/site','weather.yml','main','mine');
  assert.equal(run.id,2);
});

test('GitHub access errors are readable and never reproduce a server response containing credentials', async () => {
  const api=githubClient('private-token',async()=>({ok:false,status:403,json:async()=>({message:'private-token'})}));
  await assert.rejects(api('repos/example/site'),error=>error.message.includes('Actions') && !error.message.includes('private-token'));
});
