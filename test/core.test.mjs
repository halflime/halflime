import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let mf, db;
const token = 'test-admin-token-that-is-at-least-32-bytes';
const secrets = { ADMIN_TOKEN: token, HASH_SECRET: 'test-hash-secret-that-is-at-least-32-bytes' };
const request = (path, body, headers = {}) => mf.dispatchFetch(`http://localhost${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body)
});
const event = (extra = {}) => ({ eventId: crypto.randomUUID(), sessionId: crypto.randomUUID(), timestamp: new Date().toISOString(), eventName: 'pageview', ...extra });

before(async () => {

  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: '.test/worker.js', compatibilityDate: '2026-11-16', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'halflime-test' }, bindings: secrets }));
  db = await mf.getD1Database('DB');
  await db.exec((await readFile('migrations/0001.sql', 'utf8')).replaceAll('\n', ' '));
});
after(async () => { await mf?.dispose(); });

test('project creation and idempotent atomic ingestion use real D1', async () => {
  const response = await request('/api/v1/projects', { name: 'Test app', type: 'app', properties: ['plan'] });
  assert.equal(response.status, 201);
  const project = await response.json();
  assert.ok(project.id);
  assert.ok(project.appKey);
  const value = event({ props: { plan: 'free' } });
  const ingested = await request('/api/v1/events', [value, value], { 'App-Key': project.appKey });
  assert.equal(ingested.status, 200);
  assert.deepEqual(await ingested.json(), { accepted: 1 });
  assert.deepEqual(await (await request('/api/v1/events', [value], { 'App-Key': project.appKey })).json(), { accepted: 0 });
  assert.equal((await request('/api/v1/events', [event(), event({ eventName: '' })], { 'App-Key': project.appKey })).status, 400);
  const stored = await db.prepare('SELECT count(*) AS n FROM events WHERE project_id = ?').bind(project.id).first();
  assert.equal(stored.n, 1);
});

 test('authenticated aggregate API and official MCP client share bounded queries', async () => {
  const p = await (await request('/api/v1/projects', { name: 'Queries', type: 'app', properties: ['plan'] })).json();
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const values = [event({sessionId, timestamp, props:{plan:'free'}, systemProps:{appVersion:'1.2'}}), event({sessionId,timestamp,eventName:'purchase',props:{plan:'paid'}})];
  assert.equal((await request('/api/v1/events', values, {'App-Key':p.appKey})).status,200);
  const args = {projectId:p.id,from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+1000).toISOString()};
  const query = new URLSearchParams(args);
  assert.deepEqual(await (await request('/api/v1/stats?'+query)).json(), {events:2,sessions:1});
  assert.equal((await request('/api/v1/projects', undefined, {Authorization:'Bearer '+p.appKey})).status,401);
  const list = await (await request('/api/v1/projects')).json();
  assert.ok(list.projects.some(v=>v.id===p.id));
  assert.ok(!JSON.stringify(list).includes(p.appKey));
  assert.equal((await request('/api/v1/projects/'+p.id)).status,200);
  const breakdown = await (await request('/api/v1/breakdown?'+query+'&dimension=prop:plan')).json();
  assert.deepEqual(breakdown,{rows:[{value:'free',events:1,sessions:1},{value:'paid',events:1,sessions:1}]});
  assert.equal((await request('/api/v1/breakdown?'+query+'&dimension=prop:email')).status,400);
  assert.equal((await request('/api/v1/stats?'+new URLSearchParams({...args,from:'2020-01-01T00:00:00Z'}))).status,400);
  const timeseries = await (await request('/api/v1/timeseries?'+query+'&interval=hour')).json();
  assert.equal(timeseries.rows.length,1);
  assert.equal(timeseries.rows[0].events,2);
  const url = await mf.ready;
  const client = new Client({name:'halflime-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',url),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(v=>v.name).sort(),['create_project','get_breakdown','get_project','get_stats','get_timeseries','list_projects']);
    const stats = await client.callTool({name:'get_stats',arguments:args});
    assert.deepEqual(JSON.parse(stats.content[0].text),{events:2,sessions:1});
    const project = await client.callTool({name:'get_project',arguments:{projectId:p.id}});
    assert.equal(JSON.parse(project.content[0].text).id,p.id);
    const created = await client.callTool({name:'create_project',arguments:{name:'MCP project',type:'app',properties:[]}});
    const createdProject = JSON.parse(created.content[0].text);
    assert.ok(createdProject.appKey);
    assert.equal((await request('/api/v1/projects/'+createdProject.id)).status,200);
    const mcpList = await client.callTool({name:'list_projects',arguments:{}});
    assert.ok(JSON.parse(mcpList.content[0].text).projects.some(v=>v.id===createdProject.id));
    const mcpBreakdown = await client.callTool({name:'get_breakdown',arguments:{...args,dimension:'prop:plan'}});
    assert.deepEqual(JSON.parse(mcpBreakdown.content[0].text),breakdown);
    const mcpTimeseries = await client.callTool({name:'get_timeseries',arguments:{...args,interval:'hour'}});
    assert.deepEqual(JSON.parse(mcpTimeseries.content[0].text),timeseries);
    const invalid = await client.callTool({name:'get_stats',arguments:{...args,from:'bad'}});
    assert.equal(invalid.isError,true);
  } finally { await client.close(); }
});

test('browser CORS preflight is restrictive and Origin enforcement applies before storage', async () => {
  const project = await (await request('/api/v1/projects', { name: 'Site', type: 'website', origins: ['https://site.example'] })).json();
  assert.ok(project.appKey);
  const preflight = await mf.dispatchFetch('http://localhost/api/v1/events', { method: 'OPTIONS', headers: { Origin: 'https://site.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'app-key,content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://site.example');
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
  for (const origin of [undefined, 'null', 'https://evil.example', 'https://site.example:444', 'https://site.example/path']) {
    assert.equal((await request('/api/v1/events', [event()], { 'App-Key': project.appKey, ...(origin === undefined ? {} : { Origin: origin }) })).status, 403);
  }
  const ok = await request('/api/v1/events', [event()], { 'App-Key': project.appKey, Origin: 'https://site.example' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://site.example');
  assert.equal((await request('/api/v1/projects', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await mf.dispatchFetch('http://localhost/mcp', { method: 'POST', headers: { Origin: 'null', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
});

test('privacy sanitization persists only allowed data and scoped session HMACs', async () => {
  const p = await (await request('/api/v1/projects', { name: 'Privacy', type: 'app', properties: ['plan', 'note', 'ipText', 'detail'] })).json();
  assert.ok(p.appKey);
  const sessionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const first = event({ sessionId, timestamp, path: '/pricing?email=person@example.com#secret', referrer: 'https://name:password@example.org/somewhere?secret=discard#private', props: { plan:'free', note:'person@example.com', ipText:'192.168.1.1', detail:'Bearer abcdef', unknown:'drop' }, systemProps: { appVersion:'1.0', osName:'macOS', locale:'person@example.com', deviceModel:'Laptop', arbitrary:'drop', isDebug:false } });
  assert.equal((await request('/api/v1/events', [first], { 'App-Key': p.appKey, 'User-Agent': 'sensitive-UA', 'CF-Connecting-IP': '1.2.3.4' })).status, 200);
  const row = await db.prepare('SELECT * FROM events WHERE project_id = ?').bind(p.id).first();
  assert.deepEqual(JSON.parse(row.props), { plan:'free' });
  assert.deepEqual(JSON.parse(row.system_props), { appVersion:'1.0', osName:'macOS', deviceModel:'Laptop', isDebug:false });
  assert.equal(row.path, '/pricing');
  assert.equal(row.referrer, 'example.org');
  assert.match(row.session_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(row).includes(sessionId));
  assert.ok(!JSON.stringify(row).includes('sensitive-UA'));
  const yesterday = new Date(Date.now()-86400000).toISOString();
  await request('/api/v1/events', [event({ sessionId, timestamp }), event({ sessionId, timestamp:yesterday })], { 'App-Key':p.appKey });
  const hashes = (await db.prepare('SELECT session_hash FROM events WHERE project_id = ? ORDER BY timestamp').bind(p.id).all()).results.map(v=>v.session_hash);
  assert.equal(new Set(hashes).size, 2);
  const p2 = await (await request('/api/v1/projects', { name:'Other', type:'app' })).json();
  await request('/api/v1/events', [event({sessionId,timestamp})], {'App-Key':p2.appKey});
  assert.notEqual((await db.prepare('SELECT session_hash FROM events WHERE project_id = ?').bind(p2.id).first()).session_hash,row.session_hash);
});

test('batch bounds, malformed inputs, credentials, SQL errors and concurrent retries fail safely', async () => {
  const p = await (await request('/api/v1/projects', { name:'Boundaries',type:'app' })).json();
  for (const batch of [[], Array.from({length:26},()=>event()), [event({sessionId:'bad'})], [event({props:{nested:{secret:'x'}}})], [event({timestamp:'2000-01-01T00:00:00Z'})], [event({eventName:'person@example.com'})], [event({unknown:'field'})]]) {
    assert.equal((await request('/api/v1/events',batch,{'App-Key':p.appKey})).status,400);
  }
  assert.equal((await request('/api/v1/projects',{name:'x',type:'website',origins:[]})).status,400);
  assert.equal((await request('/api/v1/projects',{name:'x',type:'app',properties:['email']})).status,400);
  assert.equal((await request('/api/v1/projects',undefined,{Authorization:''})).status,401);
  assert.equal((await request('/api/v1/events',[event()],{'App-Key':'bad'})).status,401);
  const tooLarge = await mf.dispatchFetch('http://localhost/api/v1/events',{method:'POST',headers:{'App-Key':p.appKey,'Content-Type':'application/json'},body:' '.repeat(65537)});
  assert.equal(tooLarge.status,413);
  assert.equal((await mf.dispatchFetch('http://localhost/api/v1/events',{method:'POST',headers:{'App-Key':p.appKey,'Content-Type':'application/json'},body:'not json'})).status,400);
  assert.equal((await request('/api/v1/events',[event()],{'App-Key':p.appKey,'Content-Type':'text/plain'})).status,415);
  await db.exec("CREATE TRIGGER test_failure BEFORE INSERT ON events WHEN NEW.event_name = 'force_failure' BEGIN SELECT RAISE(ABORT, 'sensitive database details'); END;");
  const failure = await request('/api/v1/events',[event(),event({eventName:'force_failure'})],{'App-Key':p.appKey});
  assert.equal(failure.status,500);
  assert.deepEqual(await failure.json(),{error:'Internal error'});
  assert.equal((await db.prepare('SELECT count(*) AS n FROM events WHERE project_id = ?').bind(p.id).first()).n,0);
  await db.exec('DROP TRIGGER test_failure;');
  const same = event();
  const replies = await Promise.all(Array.from({length:8},()=>request('/api/v1/events',[same],{'App-Key':p.appKey}).then(v=>v.json())));
  assert.equal(replies.reduce((sum,v)=>sum+v.accepted,0),1);
  const malformedDimension = new URLSearchParams({projectId:p.id,from:new Date(Date.now()-86400000).toISOString(),to:new Date().toISOString(),dimension:'constructor'});
  assert.equal((await request('/api/v1/breakdown?'+malformedDimension)).status,400);
});

test('missing and short instance secrets fail closed while liveness stays public', async () => {
  const closed = new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:'.test/worker.js',compatibilityDate:'2026-11-16',compatibilityFlags:['nodejs_compat'],bindings:{ADMIN_TOKEN:'short',HASH_SECRET:''}}));
  try {
    assert.deepEqual(await (await closed.dispatchFetch('http://localhost/health')).json(),{ok:true});
    for (const path of ['/api/v1/projects','/api/v1/events','/mcp']) assert.equal((await closed.dispatchFetch('http://localhost'+path,{method:'POST',body:'{}'})).status,503);
  } finally { await closed.dispose(); }
});
