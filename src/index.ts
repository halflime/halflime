import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { timingSafeEqual } from 'node:crypto';

export type Env = { DB: D1Database; ADMIN_TOKEN: string; HASH_SECRET: string };
const encoder = new TextEncoder();
const uuid = z.string().uuid();
const text = (max: number) => z.string().min(1).max(max);
const property = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
const projectInput = z.object({ name: text(100), type: z.enum(['app', 'website']), origins: z.array(text(200)).max(20).default([]), properties: z.array(property).max(20).default([]) }).strict();
const eventInput = z.object({
  eventId: uuid, sessionId: uuid, timestamp: z.iso.datetime({ offset: true }), eventName: text(100),
  systemProps: z.record(z.string(), z.unknown()).optional(),
  props: z.record(z.string(), z.union([z.string().max(200), z.number().finite(), z.boolean()])).refine(v => Object.keys(v).length <= 20).optional(),
  path: text(2048).optional(), referrer: text(2048).optional()
}).strict();
const batchInput = z.array(eventInput).min(1).max(25);
type ProjectRow = { id: string; name: string; type: 'app' | 'website'; key_hash: string; origins: string; properties: string; created_at: string };
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
const sensitiveName = /email|phone|password|secret|token|credential|authorization|cookie|address|user.?id|session.?id|ip.?address|^ip$|^name$/i;
const sensitiveValue = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:[0-9a-f]{0,4}:){2,}[0-9a-f:]*|bearer\s|(?:sk|pk|ghp|github_pat|AKIA)[_-][a-z0-9]{8,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+|(?:password|token|secret|api.?key)\s*[:=]/i;
const safeString = (value: string) => !sensitiveValue.test(value) && !/[\x00-\x1f\x7f]/.test(value);
async function digest(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), x => x.toString(16).padStart(2, '0')).join(''); }
async function equal(a: string, b: string) { return timingSafeEqual(encoder.encode(await digest(a)), encoder.encode(await digest(b))); }
async function sessionHash(secret: string, project: string, day: string, session: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${project}\n${day}\n${session}`))), x => x.toString(16).padStart(2, '0')).join('');
}
async function body(request: Request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json');
  if (!request.body) throw new HttpError(400, 'Expected JSON body');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new HttpError(413, 'Body exceeds 64 KiB'); }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data)); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
function publicProject(row: ProjectRow) { return { id: row.id, name: row.name, type: row.type, origins: JSON.parse(row.origins), properties: JSON.parse(row.properties), createdAt: row.created_at }; }
function origin(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value ? value : null; } catch { return null; }
}
async function createProject(env: Env, input: unknown) {
  const data = projectInput.parse(input);
  if (!data.origins.every(value => origin(value)) || data.properties.some(value => sensitiveName.test(value)) || (data.type === 'website' && !data.origins.length)) throw new HttpError(400, 'Invalid project origins or properties');
  const appKey = `hl_${crypto.randomUUID()}${crypto.randomUUID()}`;
  const row: ProjectRow = { id: crypto.randomUUID(), name: data.name, type: data.type, key_hash: await digest(appKey), origins: JSON.stringify([...new Set(data.origins)]), properties: JSON.stringify([...new Set(data.properties)]), created_at: new Date().toISOString() };
  await env.DB.prepare('INSERT INTO projects (id,name,type,key_hash,origins,properties,created_at) VALUES (?,?,?,?,?,?,?)').bind(row.id, row.name, row.type, row.key_hash, row.origins, row.properties, row.created_at).run();
  return { ...publicProject(row), appKey };
}
function sanitizePath(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://halflime.invalid');
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const path = decodeURIComponent(url.pathname);
    return safeString(path) ? url.pathname.slice(0, 512) : null;
  } catch { return null; }
}
function sanitizeReferrer(value?: string) {
  if (!value) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && safeString(url.hostname) ? url.hostname : null; } catch { return null; }
}
async function preflight(request: Request, env: Env) {
  const value = request.headers.get('Origin') ?? '';
  const headers = (request.headers.get('Access-Control-Request-Headers') ?? '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
  if (!origin(value) || request.headers.get('Access-Control-Request-Method') !== 'POST' || headers.some(v => !['app-key', 'content-type'].includes(v))) throw new HttpError(403, 'Origin or preflight not allowed');
  const allowed = await env.DB.prepare('SELECT 1 AS allowed FROM projects, json_each(projects.origins) WHERE json_each.value = ? LIMIT 1').bind(value).first();
  if (!allowed) throw new HttpError(403, 'Origin not allowed');
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': value, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'App-Key, Content-Type', 'Vary': 'Origin', 'Cache-Control': 'no-store' } });
}
async function ingest(request: Request, env: Env) {
  const appKey = request.headers.get('App-Key') ?? '';
  if (appKey.length > 200) throw new HttpError(401, 'Invalid App-Key');
  const row = await env.DB.prepare('SELECT * FROM projects WHERE key_hash = ?').bind(await digest(appKey)).first<ProjectRow>();
  if (!row || !await equal(row.key_hash, await digest(appKey))) throw new HttpError(401, 'Invalid App-Key');
  const requestOrigin = request.headers.get('Origin');
  const allowed: string[] = JSON.parse(row.origins);
  if ((row.type === 'website' && !requestOrigin) || (requestOrigin !== null && (!origin(requestOrigin) || !allowed.includes(requestOrigin)))) throw new HttpError(403, 'Origin not allowed');
  const events = batchInput.parse(await body(request));
  const properties: string[] = JSON.parse(row.properties);
  const statements = [];
  for (const value of events) {
    if (!safeString(value.eventName)) throw new HttpError(400, 'Invalid event name');
    const timestamp = new Date(value.timestamp).toISOString();
    if (Date.parse(timestamp) > Date.now() + 300000 || Date.parse(timestamp) < Date.now() - 366 * 86400000) throw new HttpError(400, 'Timestamp outside accepted range');
    const props = Object.fromEntries(Object.entries(value.props ?? {}).filter(([key, v]) => properties.includes(key) && !sensitiveName.test(key) && (typeof v !== 'string' || safeString(v))));
    const systemProps = Object.fromEntries(Object.entries(value.systemProps ?? {}).filter(([key, v]) => key === 'isDebug' ? typeof v === 'boolean' : ['appVersion', 'appBuildNumber', 'osName', 'osVersion', 'locale', 'sdkVersion', 'deviceModel'].includes(key) && typeof v === 'string' && v.length <= 100 && safeString(v)));
    const hash = await sessionHash(env.HASH_SECRET, row.id, timestamp.slice(0, 10), value.sessionId.toLowerCase());
    statements.push(env.DB.prepare('INSERT INTO events (project_id,event_id,timestamp,session_hash,event_name,system_props,props,path,referrer) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,event_id) DO NOTHING').bind(row.id, value.eventId.toLowerCase(), timestamp, hash, value.eventName, JSON.stringify(systemProps), JSON.stringify(props), sanitizePath(value.path), sanitizeReferrer(value.referrer)));
  }
  const results = await env.DB.batch(statements);
  const response = json({ accepted: results.reduce((sum, result) => sum + result.meta.changes, 0) });
  if (requestOrigin) { response.headers.set('Access-Control-Allow-Origin', requestOrigin); response.headers.set('Vary', 'Origin'); }
  return response;
}
const rangeInput = z.object({ projectId: uuid, from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).strict();
const breakdownInput = rangeInput.extend({ dimension: text(50) });
const timeseriesInput = rangeInput.extend({ interval: z.enum(['day', 'hour']) });
async function getProject(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(uuid.parse(id)).first<ProjectRow>();
  if (!row) throw new HttpError(404, 'Project not found');
  return publicProject(row);
}
async function listProjects(env: Env) {
  const rows = await env.DB.prepare('SELECT * FROM projects ORDER BY created_at DESC, id LIMIT 101').all<ProjectRow>();
  return { projects: rows.results.slice(0, 100).map(publicProject), hasMore: rows.results.length > 100 };
}
async function aggregate(env: Env, kind: 'stats' | 'breakdown' | 'timeseries', input: unknown) {
  const data = (kind === 'breakdown' ? breakdownInput : kind === 'timeseries' ? timeseriesInput : rangeInput).parse(input);
  const from = new Date(data.from).toISOString();
  const to = new Date(data.to).toISOString();
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > 31 * 86400000) throw new HttpError(400, 'Range must be positive and at most 31 days');
  const project = await getProject(env, data.projectId);
  const params: (string | number)[] = [];
  let dimension = '';
  if (kind === 'breakdown') {
    const { dimension: name } = breakdownInput.parse(input);
    const columns: Record<string, string> = { eventName: 'event_name', appVersion: "json_extract(system_props,'$.appVersion')", osName: "json_extract(system_props,'$.osName')", path: 'path', referrer: 'referrer' };
    if (name.startsWith('prop:') && project.properties.includes(name.slice(5))) {
      dimension = 'json_extract(props, ?)';
      params.push(`$.${name.slice(5)}`);
    } else dimension = Object.hasOwn(columns, name) ? columns[name] : '';
    if (!dimension) throw new HttpError(400, 'Invalid dimension');
  }
  if (kind === 'timeseries') dimension = timeseriesInput.parse(input).interval === 'day' ? 'substr(timestamp,1,10)' : 'substr(timestamp,1,13)';
  params.push(data.projectId, from, to);
  const counts = 'count(*) AS events, count(DISTINCT session_hash) AS sessions';
  const where = 'FROM events WHERE project_id = ? AND timestamp >= ? AND timestamp < ?';
  if (kind === 'stats') return await env.DB.prepare(`SELECT ${counts} ${where}`).bind(...params).first();
  const order = kind === 'timeseries' ? 'value ASC' : 'events DESC, value ASC';
  const result = await env.DB.prepare(`SELECT ${dimension} AS value, ${counts} ${where} GROUP BY value ORDER BY ${order} LIMIT 745`).bind(...params).all();
  if (kind === 'timeseries') return { rows: result.results.map(row => ({ bucket: `${row.value}${timeseriesInput.parse(input).interval === 'day' ? 'T00' : ''}:00:00.000Z`, events: row.events, sessions: row.sessions })) };
  return { rows: result.results.slice(0, 100) };
}
async function mcp(request: Request, env: Env) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const parsedBody = await body(request);
  const server = new McpServer({ name: 'halflime', version: '0.1.0' });
  const tools = [
    ['list_projects', 'List projects (up to 100).', z.object({}).strict(), () => listProjects(env)],
    ['create_project', 'Create a project. Returns its public ingestion key once.', projectInput, (input: unknown) => createProject(env, input)],
    ['get_project', 'Get project configuration without its ingestion key.', z.object({ projectId: uuid }).strict(), (input: { projectId: string }) => getProject(env, input.projectId)],
    ['get_stats', 'Count events and day-scoped sessions in a range.', rangeInput, (input: unknown) => aggregate(env, 'stats', input)],
    ['get_breakdown', 'Aggregate an allowlisted dimension (top 100).', breakdownInput, (input: unknown) => aggregate(env, 'breakdown', input)],
    ['get_timeseries', 'Aggregate nonempty UTC hour or day buckets.', timeseriesInput, (input: unknown) => aggregate(env, 'timeseries', input)]
  ] as const;
  for (const [name, description, inputSchema, run] of tools) {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: name !== 'create_project', destructiveHint: false, openWorldHint: false } }, async (input: Record<string, unknown>) => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await run(input as { projectId: string })) }] }; }
      catch (error) { return { content: [{ type: 'text' as const, text: error instanceof HttpError ? error.message : error instanceof z.ZodError ? 'Invalid input' : 'Internal error' }], isError: true }; }
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65536 });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody });
  } finally { await server.close(); }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true });
      if (![env.ADMIN_TOKEN, env.HASH_SECRET].every(value => typeof value === 'string' && value.length >= 32 && value.length <= 1024)) throw new HttpError(503, 'Instance is not configured');
      if (url.pathname === '/api/v1/events' && request.method === 'OPTIONS') return await preflight(request, env);
      if (url.pathname === '/api/v1/events' && request.method === 'POST') return await ingest(request, env);
      if (!await equal(request.headers.get('Authorization') ?? '', `Bearer ${env.ADMIN_TOKEN}`)) throw new HttpError(401, 'Unauthorized');
      const requestOrigin = request.headers.get('Origin');
      if (requestOrigin !== null && requestOrigin !== url.origin) throw new HttpError(403, 'Origin not allowed');
      if (url.pathname === '/api/v1/projects' && request.method === 'POST') return json(await createProject(env, await body(request)), 201);
      if (url.pathname === '/api/v1/projects' && request.method === 'GET') return json(await listProjects(env));
      if (url.pathname.startsWith('/api/v1/projects/') && request.method === 'GET') return json(await getProject(env, url.pathname.slice('/api/v1/projects/'.length)));
      if (url.pathname === '/mcp') return await mcp(request, env);
      if (request.method === 'GET') {
        const query = Object.fromEntries(url.searchParams);
        if (url.pathname === '/api/v1/stats') return json(await aggregate(env, 'stats', query));
        if (url.pathname === '/api/v1/breakdown') return json(await aggregate(env, 'breakdown', query));
        if (url.pathname === '/api/v1/timeseries') return json(await aggregate(env, 'timeseries', query));
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (error instanceof z.ZodError) return json({ error: 'Invalid input' }, 400);
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      return json({ error: 'Internal error' }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
