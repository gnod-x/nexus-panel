import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { Store } from '../../src/server/db.js';
import { hashPassword } from '../../src/server/security.js';

describe('Sun-Panel migration endpoint',()=>{
  const previous=process.env.HEALTH_ALLOWED_CIDRS;
  let store:Store;let app:ReturnType<typeof buildApp>;let cookie='';
  beforeEach(async()=>{
    process.env.HEALTH_ALLOWED_CIDRS='192.168.1.0/24';
    store=new Store(':memory:');app=buildApp(store);await app.ready();
    await app.inject({method:'POST',url:'/api/auth/bootstrap',headers:{'content-type':'application/json'},payload:{email:'admin@example.test',password:'correct horse battery staple'}});
    const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{'content-type':'application/json'},payload:{email:'admin@example.test',password:'correct horse battery staple'}});
    const setCookie=login.headers['set-cookie'];
    cookie=(Array.isArray(setCookie)?setCookie[0]:setCookie||'').split(';')[0];
  });
  afterEach(async()=>{await app.close();store.db.close();if(previous===undefined)delete process.env.HEALTH_ALLOWED_CIDRS;else process.env.HEALTH_ALLOWED_CIDRS=previous;});
  const headers={'content-type':'application/json'};
  it('imports groups, associated services, and a redacted event',async()=>{
    const response=await app.inject({method:'POST',url:'/api/import/sun-panel',headers:{...headers,cookie},payload:{groups:[{name:'Infrastructure',slug:'infrastructure'}],services:[{groupSlug:'infrastructure',name:'Router',slug:'router',url:'http://192.168.1.1:80',healthUrl:'http://192.168.1.1:80/health',tags:['network']}]}});
    expect(response.statusCode).toBe(200);expect(response.json()).toEqual({imported:{groups:1,services:1}});
    expect(store.listServices()[0].groupId).toBe(store.listGroups()[0].id);
    expect(store.listEvents()[0]).toMatchObject({type:'import',metadata:{groups:1,services:1}});
  });
  it('rolls back the entire import on duplicate slugs',async()=>{
    const response=await app.inject({method:'POST',url:'/api/import/sun-panel',headers:{...headers,cookie},payload:{groups:[{name:'First',slug:'first'},{name:'Duplicate',slug:'first'}],services:[]}});
    expect(response.statusCode).toBe(409);expect(response.json()).toEqual({error:'import_conflict'});expect(store.listGroups()).toHaveLength(0);expect(store.listEvents()).toHaveLength(0);
  });
  it('rejects non-admins and oversized batches before writing',async()=>{
    store.createUser('viewer@example.test',hashPassword('viewer password long enough'),'viewer');
    const viewerLogin=await app.inject({method:'POST',url:'/api/auth/login',headers, payload:{email:'viewer@example.test',password:'viewer password long enough'}});
    const viewerSetCookie=viewerLogin.headers['set-cookie'];
    const viewerCookie=(Array.isArray(viewerSetCookie)?viewerSetCookie[0]:viewerSetCookie||'').split(';')[0];
    const deniedRole=await app.inject({method:'POST',url:'/api/import/sun-panel',headers:{...headers,cookie:viewerCookie},payload:{groups:[],services:[]}});
    expect(deniedRole.statusCode).toBe(403);
    const oversized={groups:Array.from({length:101},(_,i)=>({name:`Group ${i}`,slug:`group-${i}`})),services:[]};
    const denied=await app.inject({method:'POST',url:'/api/import/sun-panel',headers:{...headers,cookie},payload:oversized});
    expect(denied.statusCode).toBe(400);expect(store.listGroups()).toHaveLength(0);
    const tooManyServices={groups:[],services:Array.from({length:501},(_,i)=>({name:`Service ${i}`,slug:`service-${i}`,url:'http://192.168.1.1/'}))};
    const tooMany=await app.inject({method:'POST',url:'/api/import/sun-panel',headers:{...headers,cookie},payload:tooManyServices});expect(tooMany.statusCode).toBe(400);expect(store.listServices()).toHaveLength(0);
    const huge=await app.inject({method:'POST',url:'/api/import/sun-panel',headers:{...headers,cookie},payload:JSON.stringify({padding:'x'.repeat(1024*1024)})});
    expect(huge.statusCode).toBe(413);
  });
  it('requires JSON and rejects cross-origin mutations',async()=>{
    const payload={groups:[],services:[]};
    const noJson=await app.inject({method:'POST',url:'/api/import/sun-panel',headers:{cookie,'content-type':'text/plain'},payload:JSON.stringify(payload)});expect(noJson.statusCode).toBe(415);
    const cross=await app.inject({method:'POST',url:'/api/import/sun-panel',headers:{...headers,cookie,origin:'https://attacker.example'},payload});expect(cross.statusCode).toBe(403);
    const forwardedTls=await app.inject({method:'POST',url:'/api/import/sun-panel',headers:{...headers,cookie,host:'panel.example:8443',origin:'https://panel.example:8443'},payload});expect(forwardedTls.statusCode).toBe(200);
  });
  it('validates service and health URLs independently',async()=>{
    const base={name:'Router',slug:'router',url:'http://192.168.1.1:80'};
    const invalidService=await app.inject({method:'POST',url:'/api/services',headers:{...headers,cookie},payload:{...base,url:'javascript:alert(1)',healthUrl:'http://192.168.1.1/health'}});
    expect(invalidService.statusCode).toBe(400);expect(store.listServices()).toHaveLength(0);
    const invalidHealth=await app.inject({method:'POST',url:'/api/services',headers:{...headers,cookie},payload:{...base,healthUrl:'file:///etc/passwd'}});
    expect(invalidHealth.statusCode).toBe(400);expect(store.listServices()).toHaveLength(0);
  });
  it('returns conflicts for duplicate service slugs',async()=>{
    const base={name:'Router',slug:'router',url:'http://192.168.1.1:80'};
    const first=await app.inject({method:'POST',url:'/api/services',headers:{...headers,cookie},payload:base});
    expect(first.statusCode).toBe(201);
    const duplicate=await app.inject({method:'POST',url:'/api/services',headers:{...headers,cookie},payload:{...base,name:'Another Router'}});
    expect(duplicate.statusCode).toBe(409);expect(duplicate.json()).toEqual({error:'service_exists'});
  });
});
