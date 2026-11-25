import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../src/server/app.js';
import { Store } from '../../src/server/db.js';
import { hashPassword, tokenHash } from '../../src/server/security.js';

let app: ReturnType<typeof buildApp>;
let store: Store;
let saved: Record<string,string|undefined>;
const keys=['PUBLIC_ORIGIN','TASK_DEMO_MODE','INTEGRATION_DEMO_MODE','NODE_ENV'] as const;
const credentials={email:'auth-wire@audit.example.test',password:'  café synthetic audit password  '};
const headers={'content-type':'application/json'};
beforeEach(()=>{
  saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));delete process.env.PUBLIC_ORIGIN;
  process.env.NODE_ENV='test';process.env.TASK_DEMO_MODE='true';process.env.INTEGRATION_DEMO_MODE='true';
  store=new Store(':memory:');app=buildApp(store);
});
afterEach(async()=>{
  vi.restoreAllMocks();await app.close();store.db.close();
  for(const key of keys)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
});
async function bootstrap() {
  const response=await app.inject({method:'POST',url:'/api/auth/bootstrap',headers,payload:credentials});
  expect(response.statusCode).toBe(201);
}
async function wire(request:string) {
  if(!app.server.listening)await app.listen({host:'127.0.0.1',port:0});
  const port=(app.server.address() as AddressInfo).port;
  return new Promise<string>((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port});let text='';
    socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('synthetic wire fixture deadline'));});
    socket.on('connect',()=>socket.write(request));
    socket.on('data',chunk=>{text+=chunk.toString('utf8');if(text.length>16384){socket.destroy();reject(new Error('unexpected oversized fixture response'));}});
    socket.on('end',()=>resolve(text));socket.on('error',reject);
  });
}

describe('audit bootstrap and password boundaries',()=>{
  it('five concurrent bootstrap requests create one administrator only',async()=>{
    const responses=await Promise.all(Array.from({length:5},(_,index)=>app.inject({
      method:'POST',url:'/api/auth/bootstrap',headers,payload:{...credentials,email:'bootstrap-'+index+'@audit.example.test'},
    })));
    expect(responses.map(response=>response.statusCode).sort()).toEqual([201,409,409,409,409]);
    expect(store.userCount()).toBe(1);
    expect((store.db.prepare('SELECT role FROM users').get() as {role:string}).role).toBe('admin');
  });
  it('email casing/full-width punctuation normalize while Unicode passwords never normalize',async()=>{
    await bootstrap();
    const normalized=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{email:'  AUTH-WIRE＠AUDIT。EXAMPLE．TEST  ',password:credentials.password}});
    expect(normalized.statusCode).toBe(200);
    const changed=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{email:credentials.email,password:credentials.password.normalize('NFD')}});
    expect(changed.statusCode).toBe(401);
    const trimmed=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{email:credentials.email,password:credentials.password.trim()}});
    expect(trimmed.statusCode).toBe(401);
  });
  it.each([11,201])('bootstrap password length %s is rejected without creating an account',async length=>{
    const response=await app.inject({method:'POST',url:'/api/auth/bootstrap',headers,payload:{email:credentials.email,password:'x'.repeat(length)}});
    expect(response.statusCode).toBe(400);expect(store.userCount()).toBe(0);
  });
  it.each([12,200])('bootstrap password length %s remains accepted',async length=>{
    const response=await app.inject({method:'POST',url:'/api/auth/bootstrap',headers,payload:{email:credentials.email,password:'x'.repeat(length)}});
    expect(response.statusCode).toBe(201);expect(store.userCount()).toBe(1);
  });
  it.each([null,42,{},[],true])('non-string synthetic password #%# is a controlled input error',async password=>{
    const response=await app.inject({method:'POST',url:'/api/auth/bootstrap',headers,payload:{email:credentials.email,password}});
    expect(response.statusCode).toBe(400);expect(store.userCount()).toBe(0);
  });
  it('bootstrap ignores attempts to supply a password hash or privileged session fields',async()=>{
    const response=await app.inject({method:'POST',url:'/api/auth/bootstrap',headers,payload:{...credentials,passwordHash:'SYNTHETIC_FORGED_HASH',id:9001,role:'superuser',session:'SYNTHETIC_FORGED_TOKEN'}});
    expect(response.statusCode).toBe(201);expect(response.json().user.role).toBe('admin');expect(response.json().user.id).toBe(1);
    const stored=store.getUserByEmail(credentials.email)!;
    expect(stored.passwordHash).not.toBe('SYNTHETIC_FORGED_HASH');
    expect(response.body).not.toContain('SYNTHETIC_FORGED');
  });
});

describe('audit isolated authentication rate controls',()=>{
  it('eleventh invalid login is limited and forged forwarded IPs do not bypass it',async()=>{
    const statuses:number[]=[];
    for(let index=0;index<11;index++){
      const response=await app.inject({method:'POST',url:'/api/auth/login',headers:{...headers,'x-forwarded-for':'192.0.2.'+(index+1)},payload:{email:'missing@audit.example.test',password:'synthetic invalid'}});
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0,10)).toEqual(Array(10).fill(401));expect(statuses[10]).toBe(429);
    expect(store.userCount()).toBe(0);
  });
  it('expired rate-limit windows reset via deterministic clock advancement, with no sleep',async()=>{
    let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);
    const request=()=>app.inject({method:'POST',url:'/api/auth/login',headers,payload:{email:'missing@audit.example.test',password:'synthetic'}});
    for(let index=0;index<10;index++)expect((await request()).statusCode).toBe(401);
    expect((await request()).statusCode).toBe(429);now+=60001;expect((await request()).statusCode).toBe(401);
  });
  it('a forged Origin never consumes successful account creation or yields a session',async()=>{
    const response=await app.inject({method:'POST',url:'/api/auth/bootstrap',headers:{...headers,origin:'https://foreign.audit.invalid'},payload:credentials});
    expect(response.statusCode).toBe(403);expect(response.headers['set-cookie']).toBeUndefined();expect(store.userCount()).toBe(0);
  });
});

describe('audit HTTP parser behavior on isolated random loopback listeners',()=>{
  it.each([
    ['duplicate content lengths','Content-Length: 2\r\nContent-Length: 2\r\n'],
    ['transfer encoding and content length','Content-Length: 2\r\nTransfer-Encoding: chunked\r\n'],
    ['negative content length','Content-Length: -1\r\n'],
    ['nondecimal content length','Content-Length: nonsense\r\n'],
  ])('rejects %s before executing an authenticated mutation',async(_name,bodyHeaders)=>{
    const user=store.createUser('wire-admin@audit.example.test','unused-hash','admin');
    store.saveSession(tokenHash('synthetic-wire-admin'),user.id,new Date(Date.now()+60000).toISOString());
    const response=await wire('POST /api/groups HTTP/1.1\r\nHost: localhost\r\nCookie: nexus_session=synthetic-wire-admin\r\nContent-Type: application/json\r\n'+bodyHeaders+'Connection: close\r\n\r\n{}');
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(store.listGroups()).toHaveLength(0);expect(response).not.toContain('synthetic-wire-admin');
  });
  it('oversized Cookie headers are rejected by the transport without invoking application writes',async()=>{
    const response=await wire('POST /api/groups HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nCookie: synthetic='+'x'.repeat(65536)+'\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
    expect(response).toMatch(/^HTTP\/1\.1 (400|431) /);expect(store.listGroups()).toHaveLength(0);
  });
  it('public health and setup are public; HEAD still enforces auth for private data',async()=>{
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    expect((await app.inject('/api/auth/status')).statusCode).toBe(200);
    for(const url of ['/api/tasks','/api/integrations','/api/services']){
      const response=await app.inject({method:'HEAD',url});expect(response.statusCode).toBe(401);expect(response.body).toBe('');
    }
  });
  it('unimplemented HTTP methods never become an execution or configuration path',async()=>{
    for(const method of ['PUT','OPTIONS','TRACE'] as const)for(const url of ['/api/tasks/run','/api/integrations/config','/api/services']){
      const response=await app.inject({method,url,headers:method==='OPTIONS'?{}:headers,payload:method==='OPTIONS'?undefined:{}});
      expect(response.statusCode,method+' '+url).toBe(404);
    }
  });
});
