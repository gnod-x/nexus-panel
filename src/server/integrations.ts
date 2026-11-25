import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import crypto from "node:crypto";
import { z } from "zod";
import { resolveTarget } from "./security.js";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { IntegrationSnapshot, IntegrationConnection, IntegrationKind, IntegrationMetric, IntegrationError } from "../shared/integrations.js";

const catalog: IntegrationSnapshot["available"] = [
  {kind:"cfspeed",name:"CFSpeed",summary:"读取最近测速的候选与验证数量，不启动扫描或切换节点。",authentication:"none"},
  {kind:"quark-vod",name:"Quark-VOD",summary:"读取保存、待处理、失败和播放请求计数，不读取媒体名称或执行转存。",authentication:"bearer-file"},
];
const configItem = z.object({
  id:z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name:z.string().min(1).max(60).regex(/^[\p{L}\p{N} ._-]+$/u),
  kind:z.enum(["cfspeed","quark-vod"]),
  baseUrl:z.string().url().max(2048).refine(value=>{
    try {const u=new URL(value);return ["http:","https:"].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}
  }),
  serviceSlug:z.string().regex(/^[a-z0-9-]{1,96}$/).optional(),
  tokenFile:z.string().max(256).refine(value=>{const p=path.resolve(value);return path.isAbsolute(value)&&p===value&&p.startsWith("/run/secrets/");}).optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.kind==="quark-vod"&&!value.tokenFile)ctx.addIssue({code:"custom",message:"Bearer file required"});
  if(value.kind==="cfspeed"&&value.tokenFile)ctx.addIssue({code:"custom",message:"Token not used"});
});
const configSchema=z.object({version:z.literal(1),connections:z.array(configItem).max(12)}).strict().superRefine((value,ctx)=>{
  if(new Set(value.connections.map(c=>c.id)).size!==value.connections.length)ctx.addIssue({code:"custom",message:"Duplicate ID"});
});
type ConfigItem=z.infer<typeof configItem>;
export interface IntegrationOptions {configPath:string;demoMode:boolean;now?:()=>number}
export function integrationOptions():IntegrationOptions {
  return {configPath:process.env.INTEGRATION_CONFIG_PATH||"/data/integrations.json",demoMode:process.env.INTEGRATION_DEMO_MODE==="true"};
}
class IntegrationFailure extends Error {
  constructor(readonly code:Exclude<IntegrationError,null>){super(code);}
}
async function readSmallFile(filename:string,maximum:number):Promise<Buffer> {
  const handle=await fs.promises.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>maximum)throw new IntegrationFailure("config_invalid");
    const buffer=Buffer.alloc(maximum+1);
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    if(bytesRead>maximum)throw new IntegrationFailure("config_invalid");
    return buffer.subarray(0,bytesRead);
  }finally {await handle.close();}
}
type Resolver=typeof resolveTarget;
export async function fetchIntegrationJson(target:string,bearer?:string,options:{resolve?:Resolver;timeoutMs?:number}={}):Promise<unknown> {
  const controller=new AbortController();const timeoutMs=options.timeoutMs??4000;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>{const cause=new IntegrationFailure("timeout");controller.abort(cause);reject(cause);},timeoutMs);
  });
  const requestJson=async()=>{
    let resolved:Awaited<ReturnType<Resolver>>;
    try{resolved=await(options.resolve??resolveTarget)(target);}catch{throw new IntegrationFailure("target_blocked");}
    controller.signal.throwIfAborted();
    const {url,address}=resolved;const hostname=url.hostname.replace(/^\[|\]$/g,"");
    const transport=url.protocol==="https:"?https:http;
    return new Promise<unknown>((resolve,reject)=>{
      const request=transport.request({
        hostname:address,port:url.port||undefined,path:url.pathname+url.search,method:"GET",agent:false,
        signal:controller.signal,servername:net.isIP(hostname)?"":hostname,
        checkServerIdentity:(_host,cert)=>tls.checkServerIdentity(hostname,cert),
        headers:{host:url.host,accept:"application/json","user-agent":"NexusPanel-ReadOnly/1.0",...(bearer?{authorization:"Bearer "+bearer}:{})},
      },response=>{
        const fail=(code:Exclude<IntegrationError,null>)=>{response.destroy();reject(new IntegrationFailure(code));};
        if(response.statusCode===401||response.statusCode===403){fail("permission_denied");return;}
        if((response.statusCode??0)<200||(response.statusCode??0)>=300){fail("unavailable");return;}
        const media=(response.headers["content-type"]||"").split(";")[0]?.trim().toLowerCase()||"";
        if(!(media==="application/json"||media.endsWith("+json"))||(response.headers["content-encoding"]&&response.headers["content-encoding"]!=="identity")){fail("unsupported_data");return;}
        const limit=512*1024;const length=Number(response.headers["content-length"]);
        if(Number.isFinite(length)&&length>limit){fail("response_too_large");return;}
        const chunks:Buffer[]=[];let size=0;
        response.on("data",(chunk:Buffer)=>{
          size+=chunk.length;
          if(size>limit){fail("response_too_large");return;}
          chunks.push(chunk);
        });
        response.once("end",()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));}catch{reject(new IntegrationFailure("unsupported_data"));}});
        response.once("error",()=>reject(new IntegrationFailure("unavailable")));
      });
      request.once("error",()=>reject(controller.signal.aborted?new IntegrationFailure("timeout"):new IntegrationFailure("unavailable")));
      request.end();
    });
  };
  try{return await Promise.race([requestJson(),deadline]);}finally{clearTimeout(timer);}
}
function explicitSourceTime(value:string|undefined):string|null {
  if(!value)return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match)return null;
  const [,year,month,day,hour,minute,second,zone]=match;
  const y=Number(year),m=Number(month),d=Number(day);
  const days=[31,(y%4===0&&(y%100!==0||y%400===0))?29:28,31,30,31,30,31,31,30,31,30,31];
  if(m<1||m>12||d<1||d>days[m-1]!||Number(hour)>23||Number(minute)>59||Number(second)>59)return null;
  if(zone!=="Z"&&(Number(zone!.slice(1,3))>23||Number(zone!.slice(4,6))>59))return null;
  const timestamp=Date.parse(value);
  return Number.isFinite(timestamp)?new Date(timestamp).toISOString():null;
}
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const speedSchema=z.object({total_scanned:count,total_verified:count,jp_recommendations:z.array(z.unknown()).max(5000),us_recommendations:z.array(z.unknown()).max(5000),scanning:z.boolean(),updated_at:z.string().max(64).optional()});
const vodSchema=z.object({done:count,pending:count,searching:count,found:count,saving:count,failed:count,plays:count});
export function summarizeIntegration(kind:IntegrationKind,input:unknown):{metrics:IntegrationMetric[];sourceUpdatedAt:string|null} {
  if(kind==="cfspeed"){
    const parsed=speedSchema.safeParse(input);if(!parsed.success)throw new IntegrationFailure("unsupported_data");
    const p=parsed.data;
    const explicit=explicitSourceTime(p.updated_at);
    return {sourceUpdatedAt:explicit,metrics:[
      {key:"scanned",label:"测速候选",value:p.total_scanned,unit:"个"},
      {key:"verified",label:"已验证候选",value:p.total_verified,unit:"个"},
      {key:"japan",label:"日本参考",value:p.jp_recommendations.length,unit:"个"},
      {key:"america",label:"美国参考",value:p.us_recommendations.length,unit:"个"},
      {key:"scanning",label:"扫描状态",value:p.scanning?"进行中":"空闲"},
    ]};
  }
  const parsed=vodSchema.safeParse(input);if(!parsed.success)throw new IntegrationFailure("unsupported_data");
  const p=parsed.data;
  const pending=p.pending+p.searching+p.found+p.saving;if(!Number.isSafeInteger(pending))throw new IntegrationFailure("unsupported_data");
  return {sourceUpdatedAt:null,metrics:[
    {key:"saved",label:"已保存记录",value:p.done,unit:"条"},
    {key:"pending",label:"待处理记录",value:pending,unit:"条"},
    {key:"failed",label:"失败记录",value:p.failed,unit:"条"},
    {key:"plays",label:"播放请求",value:p.plays,unit:"次"},
  ]};
}
const cache=new Map<string,{at:number;result:IntegrationConnection}>();
const pendingRequests=new Map<string,Promise<IntegrationConnection>>();
function emptyConnection(kind:IntegrationKind):IntegrationConnection {
  const c=catalog.find(c=>c.kind===kind)!;
  return {id:kind,name:c.name,kind,status:"unconfigured",serviceSlug:null,observedAt:null,checkedAt:null,sourceUpdatedAt:null,freshness:"unknown",metrics:[],errorCode:null};
}
function errorCode(error:unknown):Exclude<IntegrationError,null> {
  if(error instanceof IntegrationFailure)return error.code;
  if(typeof error==="object"&&error&&"code"in error&&["EACCES","EPERM"].includes(String(error.code)))return "permission_denied";
  return "unavailable";
}
async function collectOne(item:ConfigItem,now:number):Promise<IntegrationConnection> {
  const key=crypto.createHash("sha256").update(JSON.stringify(item)).digest("hex");
  const cached=cache.get(key);if(cached&&now-cached.at>=0&&now-cached.at<30_000)return cached.result;
  if(pendingRequests.has(key))return pendingRequests.get(key)!;
  const run=async()=>{
    const base={...emptyConnection(item.kind),id:item.id,name:item.name,serviceSlug:item.serviceSlug??null};
    let result:IntegrationConnection;
    try {
      let bearer:string|undefined;
      if(item.tokenFile){
        const parent=await fs.promises.realpath(path.dirname(item.tokenFile));
        if(parent!=="/run/secrets"&&!parent.startsWith("/run/secrets/"))throw new IntegrationFailure("config_invalid");
        const value=(await readSmallFile(path.join(parent,path.basename(item.tokenFile)),4096)).toString("utf8").trim();
        if(!value||/[\r\n\x00]/.test(value))throw new IntegrationFailure("config_invalid");
        bearer=value;
      }
      const endpoint=item.kind==="cfspeed"?"/api/results":"/stats";
      const baseUrl=new URL(item.baseUrl);baseUrl.pathname=baseUrl.pathname.replace(/\/$/,"")+endpoint;
      const summary=summarizeIntegration(item.kind,await fetchIntegrationJson(baseUrl.href,bearer));
      const observedAt=new Date(now).toISOString();
      const sourceTime=summary.sourceUpdatedAt?Date.parse(summary.sourceUpdatedAt):null;
      const freshness=item.kind==="cfspeed"
        ? sourceTime===null||sourceTime>now?"unknown":now-sourceTime>24*3600_000?"stale":"fresh"
        : "fresh";
      result={...base,...summary,status:"connected",observedAt,checkedAt:observedAt,freshness};
    }catch(cause){
      result={...(cached?.result??base),status:"error",checkedAt:new Date(now).toISOString(),freshness:cached?.result.observedAt?"stale":"unknown",errorCode:errorCode(cause)};
    }
    cache.set(key,{at:now,result});if(cache.size>24)cache.delete(cache.keys().next().value!);return result;
  };
  const promise=run();pendingRequests.set(key,promise);
  try{return await promise;}finally{pendingRequests.delete(key);}
}
export async function readIntegrationSnapshot(options=integrationOptions()):Promise<IntegrationSnapshot> {
  const now=(options.now??Date.now)();const observedAt=new Date(now).toISOString();
  if(options.demoMode){
    const demo=(kind:IntegrationKind,input:unknown):IntegrationConnection=>({...emptyConnection(kind),status:"demo",observedAt,checkedAt:observedAt,freshness:"fresh",...summarizeIntegration(kind,input)});
    return {version:1,mode:"demo",observedAt,available:catalog,connections:[
      demo("cfspeed",{total_scanned:64,total_verified:18,jp_recommendations:Array(6).fill({}),us_recommendations:Array(4).fill({}),scanning:false}),
      demo("quark-vod",{done:42,pending:2,searching:1,found:0,saving:0,failed:1,plays:108}),
    ]};
  }
  let raw:Buffer;
  try{raw=await readSmallFile(options.configPath,64*1024);}catch(cause){
    if(typeof cause==="object"&&cause&&"code"in cause&&cause.code==="ENOENT")return {version:1,mode:"unconfigured",observedAt,available:catalog,connections:catalog.map(c=>emptyConnection(c.kind))};
    return {version:1,mode:"live",observedAt,available:catalog,connections:catalog.map(c=>({...emptyConnection(c.kind),status:"error",errorCode:errorCode(cause)}))};
  }
  let parsed:ReturnType<typeof configSchema.safeParse>;
  try{parsed=configSchema.safeParse(JSON.parse(raw.toString("utf8")));}catch{parsed={success:false} as typeof parsed;}
  if(!parsed.success)return {version:1,mode:"live",observedAt,available:catalog,connections:catalog.map(c=>({...emptyConnection(c.kind),status:"error",errorCode:"config_invalid"}))};
  const connections:IntegrationConnection[]=[];
  for(let i=0;i<parsed.data.connections.length;i+=3)connections.push(...await Promise.all(parsed.data.connections.slice(i,i+3).map(item=>collectOne(item,now))));
  for(const entry of catalog)if(!connections.some(c=>c.kind===entry.kind))connections.push(emptyConnection(entry.kind));
  return {version:1,mode:parsed.data.connections.length?"live":"unconfigured",observedAt,available:catalog,connections};
}
export function registerIntegrationRoutes(app:FastifyInstance,auth:preHandlerHookHandler,options=integrationOptions()):void {
  app.get("/api/integrations",{preHandler:auth},async(_request,reply)=>{
    reply.header("Cache-Control","no-store");
    return {snapshot:await readIntegrationSnapshot(options)};
  });
}
