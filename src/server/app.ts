import Fastify, { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import { authEmail, authLoginIdentity, configuredLoginUsername } from './auth-input.js';
import { Store } from './db.js';
import { hashPassword, randomToken, tokenHash, validateTargetUrl, verifyPassword } from './security.js';
import { probeHealth } from './health.js';
import { Role } from './types.js';
import { registerTaskRoutes } from './tasks.js';
import { registerIntegrationRoutes } from './integrations.js';
import { HOME_FONT_IDS } from '../shared/home-fonts.js';
import { AppSettings } from './settings.js';
import fs from 'node:fs';
import path from 'node:path';

const group = z.object({name:z.string().trim().min(1).max(80),slug:z.string().regex(/^[a-z0-9-]+$/),color:z.string().regex(/^#[0-9a-f]{6}$/i).optional()});
const service = z.object({groupId:z.number().int().positive().nullable().optional(),name:z.string().trim().min(1).max(100),slug:z.string().regex(/^[a-z0-9-]+$/),description:z.string().max(500).optional(),url:z.string().url(),healthUrl:z.string().url().nullable().optional(),icon:z.string().max(500).nullable().optional(),tags:z.array(z.string().max(40)).max(20).optional(),enabled:z.boolean().optional(),sortOrder:z.number().int().min(0).max(100000).optional()});
const importSchema=z.object({groups:z.array(group).max(100),services:z.array(z.object({groupSlug:z.string().regex(/^[a-z0-9-]+$/).optional(),name:z.string().trim().min(1).max(100),slug:z.string().regex(/^[a-z0-9-]+$/),description:z.string().max(500).optional(),url:z.string().url(),healthUrl:z.string().url().nullable().optional(),icon:z.string().max(500).nullable().optional(),tags:z.array(z.string().max(40)).max(20).optional()})).max(500)});
const settingsPatch=z.object({homeFont:z.enum(HOME_FONT_IDS)}).strict();
declare module 'fastify' { interface FastifyRequest { currentUser?: any } }

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function parseHttpOrigin(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function configuredPublicOrigin(): string | undefined {
  const value = process.env.PUBLIC_ORIGIN;
  if (!value) return undefined;
  const parsed = parseHttpOrigin(value);
  if (!parsed) throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment');
  return parsed.origin;
}

export function buildApp(store=new Store(), appSettings=new AppSettings()): FastifyInstance {
  const publicOrigin = configuredPublicOrigin();
  const loginUsername = configuredLoginUsername();
  const loginIdentity = authLoginIdentity(Boolean(loginUsername));
  const app=Fastify({logger:process.env.NODE_ENV!=='test',bodyLimit:2*1024*1024}); app.register(cookie); const cookieName='nexus_session'; const secure=process.env.NODE_ENV==='production';
  app.setErrorHandler((error:FastifyError,_request,reply)=>{
    const status=error.statusCode&&error.statusCode>=400&&error.statusCode<500?error.statusCode:500;
    const codes:Record<number,string>={400:'invalid_json',404:'not_found',405:'method_not_allowed',413:'payload_too_large',415:'json_required',429:'rate_limited'};
    return reply.code(status).send({error:codes[status]??(status===500?'internal_error':'request_rejected')});
  });
  app.setNotFoundHandler((_request,reply)=>reply.code(404).send({error:'not_found'}));
  const auth=async(req:FastifyRequest,reply:any)=>{const token=req.cookies[cookieName];const s=token&&store.getSession(tokenHash(token));if(!s||!Number.isFinite(Date.parse(s.expiresAt))||Date.parse(s.expiresAt)<=Date.now())return reply.code(401).send({error:'unauthorized'});const u=store.getUser(s.userId);if(!u)return reply.code(401).send({error:'unauthorized'});req.currentUser=u;};
  const role=(roles:Role[])=>async(req:FastifyRequest,reply:any)=>{await auth(req,reply);if(reply.sent)return;if(!roles.includes(req.currentUser.role))return reply.code(403).send({error:'forbidden'});};
  const recordId=async(req:FastifyRequest,reply:any)=>{
    const id=(req.params as {id?:unknown}).id;
    if(typeof id!=='string'||!(/^[1-9]\d*$/.test(id))||!Number.isSafeInteger(Number(id)))return reply.code(400).send({error:'invalid_id'});
  };
  const attempts=new Map<string,{n:number;t:number}>(); const limit=async(req:FastifyRequest,reply:any)=>{const k=req.ip,n=Date.now(),v=attempts.get(k);if(v&&v.t>n&&v.n>=10)return reply.code(429).send({error:'rate_limited'});if(!v||v.t<=n)attempts.set(k,{n:1,t:n+60000});else v.n++;if(attempts.size>10000)for(const [ip,entry] of attempts)if(entry.t<=n)attempts.delete(ip);if(attempts.size>12000)return reply.code(429).send({error:'rate_limited'});};
  app.addHook('preHandler', async (req, reply) => {
    if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return;
    const mediaType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json' && !mediaType?.endsWith('+json')) {
      return reply.code(415).send({ error: 'json_required' });
    }
    const origin = req.headers.origin;
    if (origin) {
      const parsed = parseHttpOrigin(origin);
      const allowed = parsed && (publicOrigin
        ? parsed.origin === publicOrigin
        : parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase());
      if (!allowed) return reply.code(403).send({ error: 'origin_forbidden' });
    }
  });
  registerTaskRoutes(app, auth);
  registerIntegrationRoutes(app, auth);

  app.get('/api/health',async()=>({status:'ok',version:process.env.APP_VERSION||'dev',timestamp:new Date().toISOString()}));
  app.get('/api/auth/status',async()=>({bootstrapped:store.userCount()>0,...(loginUsername?{usernameLoginEnabled:true}:{})}));
  app.post('/api/auth/bootstrap',{preHandler:limit},async(req,reply)=>{const p=z.object({email:authEmail,password:z.string().min(12).max(200)}).safeParse(req.body);if(!p.success)return reply.code(400).send({error:'invalid_input',details:p.error.flatten()});const passwordHash=hashPassword(p.data.password);try{const u=store.transactionImmediate(()=>{if(store.userCount())throw new Error('already');return store.createUser(p.data.email,passwordHash,'admin')});return reply.code(201).send({user:u});}catch(e:any){return reply.code(409).send({error:e.message==='already'?'already_bootstrapped':'bootstrap_failed'});}});
  app.post('/api/auth/login',{preHandler:limit},async(req,reply)=>{const p=z.object({email:loginIdentity,password:z.string().min(1).max(200)}).safeParse(req.body);if(!p.success)return reply.code(400).send({error:'invalid_input'});const email=loginUsername&&p.data.email===loginUsername.username?store.getUser(loginUsername.userId)?.email:p.data.email;const u=email?store.getUserByEmail(email):undefined;if(!u||!verifyPassword(p.data.password,u.passwordHash))return reply.code(401).send({error:'invalid_credentials'});const token=randomToken(),expires=new Date(Date.now()+28800000).toISOString();store.saveSession(tokenHash(token),u.id,expires);reply.setCookie(cookieName,token,{httpOnly:true,sameSite:'lax',secure,path:'/',expires:new Date(expires)});return {user:{id:u.id,email:u.email,role:u.role,createdAt:u.createdAt}};});
  app.post('/api/auth/logout',{preHandler:auth},async(req,reply)=>{const t=req.cookies[cookieName];if(t)store.deleteSession(tokenHash(t));reply.clearCookie(cookieName,{path:'/'});return {ok:true};});
  app.get('/api/auth/me',{preHandler:auth},async req=>({user:req.currentUser}));
  app.get('/api/settings',{preHandler:auth},async()=>({homeFont:appSettings.getHomeFont()}));
  app.patch('/api/settings',{preHandler:role(['admin'])},async(req,reply)=>{
    const parsed=settingsPatch.safeParse(req.body);
    if(!parsed.success)return reply.code(400).send({error:'invalid_input'});
    appSettings.setHomeFont(parsed.data.homeFont);
    return {homeFont:parsed.data.homeFont};
  });
  app.get('/api/overview',{preHandler:auth},async()=>store.overview());
  app.get('/api/groups',{preHandler:auth},async()=>({groups:store.listGroups()}));
  app.post('/api/groups',{preHandler:role(['admin','operator'])},async(req,reply)=>{const p=group.safeParse(req.body);if(!p.success)return reply.code(400).send({error:'invalid_input',details:p.error.flatten()});try{return reply.code(201).send({group:store.createGroup(p.data)});}catch(error){if(isUniqueConstraint(error))return reply.code(409).send({error:'group_exists'});throw error;}});
  app.patch('/api/groups/:id',{preHandler:[role(['admin','operator']),recordId]},async(req,reply)=>{const p=group.partial().extend({sortOrder:z.number().int().min(0).max(100000).optional()}).safeParse(req.body),id=Number((req.params as any).id);if(!p.success)return reply.code(400).send({error:'invalid_input'});try{const g=store.updateGroup(id,p.data);return g?{group:g}:reply.code(404).send({error:'not_found'});}catch(error){if(isUniqueConstraint(error))return reply.code(409).send({error:'group_exists'});throw error;}});
  app.delete('/api/groups/:id',{preHandler:[role(['admin']),recordId]},async req=>{store.deleteGroup(Number((req.params as any).id));return {ok:true};});
  app.post('/api/import/sun-panel',{bodyLimit:1024*1024,preHandler:role(['admin'])},async(req,reply)=>{
    const raw=JSON.stringify(req.body??{});if(Buffer.byteLength(raw,'utf8')>1024*1024)return reply.code(413).send({error:'payload_too_large'});
    const parsed=importSchema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'invalid_input',details:parsed.error.flatten()});
    try { for(const item of parsed.data.services){await validateTargetUrl(item.url);if(item.healthUrl)await validateTargetUrl(item.healthUrl);} } catch { return reply.code(400).send({error:'invalid_target'}); }
    try {
      const imported=store.transactionImmediate(()=>{
        const groupsBySlug=new Map(store.listGroups().map(g=>[g.slug,g]));
        let groupCount=0, serviceCount=0;
        for(const g of parsed.data.groups){const created=store.createGroup(g);groupsBySlug.set(created.slug,created);groupCount++;}
        for(const item of parsed.data.services){const groupId=item.groupSlug?groupsBySlug.get(item.groupSlug)?.id:null;if(item.groupSlug&&!groupId)throw new Error('missing_group');store.createService({...item,groupId});serviceCount++;}
        store.addEvent(null,'import','Imported Sun-Panel data',{groups:groupCount,services:serviceCount});
        return {groups:groupCount,services:serviceCount};
      });
      return {imported};
    } catch(e:any) { if(e.message==='missing_group')return reply.code(400).send({error:'missing_group'});return reply.code(409).send({error:'import_conflict'}); }
  });
  app.get('/api/services',{preHandler:auth},async()=>({services:store.listServices()}));
  app.post('/api/services',{preHandler:role(['admin','operator'])},async(req,reply)=>{const p=service.safeParse(req.body);if(!p.success)return reply.code(400).send({error:'invalid_input',details:p.error.flatten()});try{await validateTargetUrl(p.data.url);if(p.data.healthUrl)await validateTargetUrl(p.data.healthUrl);}catch{return reply.code(400).send({error:'invalid_target'});}if(p.data.groupId!=null&&!store.getGroup(p.data.groupId))return reply.code(400).send({error:'invalid_group'});try{return reply.code(201).send({service:store.createService(p.data)});}catch(error){if(isUniqueConstraint(error))return reply.code(409).send({error:'service_exists'});throw error;}});
  app.patch('/api/services/:id',{preHandler:[role(['admin','operator']),recordId]},async(req,reply)=>{const p=service.partial().safeParse(req.body),id=Number((req.params as any).id);if(!p.success)return reply.code(400).send({error:'invalid_input'});if(!store.getService(id))return reply.code(404).send({error:'not_found'});try{if(p.data.url)await validateTargetUrl(p.data.url);if(p.data.healthUrl)await validateTargetUrl(p.data.healthUrl);}catch{return reply.code(400).send({error:'invalid_target'});}if(p.data.groupId!=null&&!store.getGroup(p.data.groupId))return reply.code(400).send({error:'invalid_group'});try{const s=store.updateService(id,p.data);return s?{service:s}:reply.code(404).send({error:'not_found'});}catch(error){if(isUniqueConstraint(error))return reply.code(409).send({error:'service_exists'});throw error;}});
  app.delete('/api/services/:id',{preHandler:[role(['admin']),recordId]},async req=>{store.deleteService(Number((req.params as any).id));return {ok:true};});
  app.post<{Params:{id:string}}>('/api/services/:id/check',{preHandler:[role(['admin','operator']),recordId]},async(req,reply)=>{
    const id=Number(req.params.id), service=store.getService(id);
    if(!service)return reply.code(404).send({error:'not_found'});
    const started=performance.now();
    let httpStatus:number|undefined;
    try { httpStatus=await probeHealth(service.healthUrl||service.url); } catch { /* A failed probe is an offline result. */ }
    const latencyMs=Math.round(performance.now()-started);
    const status=httpStatus===undefined||httpStatus>=500?'offline':httpStatus<400?'healthy':'degraded';
    const message=httpStatus===undefined?'Request failed':`HTTP ${httpStatus}`;
    const updated=store.transactionImmediate(()=>{
      const result=store.updateService(id,{status,latencyMs,lastCheckedAt:new Date().toISOString()});
      if(result)store.addEvent(id,'health_check',message,{status,latencyMs});
      return result;
    });
    if(!updated)return reply.code(404).send({error:'not_found'});
    return {service:updated,result:{status,latencyMs,httpStatus,message}};
  });
  app.get('/api/events',{preHandler:auth},async req=>({events:store.listEvents(Number((req.query as any)?.limit||50))}));
  const root=path.resolve(process.env.CLIENT_DIST||path.resolve(process.cwd(),'dist/client'));
  const sendClientFile=async(filePath:string,reply:any)=>{const resolved=path.resolve(root,filePath);if(!resolved.startsWith(`${root}${path.sep}`)&&resolved!==path.join(root,'index.html'))return reply.code(404).send({error:'not_found'});if(!fs.existsSync(resolved)||!fs.statSync(resolved).isFile())return reply.code(404).send({error:'not_found'});const ext=path.extname(resolved);const contentType=ext==='.html'?'text/html; charset=utf-8':ext==='.js'?'text/javascript; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':ext==='.svg'?'image/svg+xml':ext==='.png'?'image/png':ext==='.woff2'?'font/woff2':'application/octet-stream';return reply.type(contentType).send(fs.createReadStream(resolved));};
  app.get('/',async(_req,reply)=>sendClientFile('index.html',reply));
  app.get('/assets/*',async(req,reply)=>sendClientFile(`assets/${(req.params as any)['*']}`,reply));
  return app;
}
