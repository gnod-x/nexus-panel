import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { Store } from '../../src/server/db.js';
import { buildApp } from '../../src/server/app.js';
import * as security from '../../src/server/security.js';
import * as health from '../../src/server/health.js';
import type { Role } from '../../src/server/types.js';

const original = {...process.env};
let app:ReturnType<typeof buildApp>|undefined;
let store:Store|undefined;
afterEach(async()=>{
  vi.restoreAllMocks();await app?.close();store?.db.close();app=undefined;store=undefined;
  for(const key of ['TASK_DEMO_MODE','INTEGRATION_DEMO_MODE','PUBLIC_ORIGIN','NODE_ENV']) {
    if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];
  }
});
type GroupModel={id:number;name:string;slug:string};
type ServiceModel={id:number;name:string;slug:string;groupId:number|null;enabled:boolean;status:string};

describe('audit deterministic model-based authorization and data invariants',()=>{
  it('seed 0x4e585553: 1000 mixed actor/actions preserve permissions, FK semantics, atomicity and counts',async()=>{
    delete process.env.PUBLIC_ORIGIN;process.env.NODE_ENV='test';process.env.TASK_DEMO_MODE='true';process.env.INTEGRATION_DEMO_MODE='true';
    store=new Store(':memory:');const db=store;app=buildApp(db);const api=app;
    const originalRoles:Role[]=['admin','operator','viewer'];
    const actors=originalRoles.map((role,index)=>{
      const user=db.createUser('model-'+index+'@audit.example.test','unused synthetic hash',role);const token='synthetic-model-'+index;
      db.saveSession(security.tokenHash(token),user.id,new Date(Date.now()+3600000).toISOString());
      return {id:user.id,role,defaultRole:role,cookie:'nexus_session='+token,label:role};
    });
    vi.spyOn(security,'validateTargetUrl').mockImplementation(async value=>new URL(value));
    const probe=vi.spyOn(health,'probeHealth').mockResolvedValue(204);
    const groups=new Map<number,GroupModel>();const services=new Map<number,ServiceModel>();
    let events=0;let state=0x4e585553;
    const next=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
    const choose=<T,>(values:T[])=>values.length?values[next()%values.length]:undefined;
    const pickGroup=()=>choose([...groups.values()]);const pickService=()=>choose([...services.values()]);
    const operationCounts:Record<string,number>={};const actorCounts:Record<string,number>={};const statusCounts:Record<string,number>={};let roleTransitions=0;
    const checkState=(context:string)=>{
      const actualGroups=db.listGroups().map(({id,name,slug})=>({id,name,slug})).sort((a,b)=>a.id-b.id);
      const expectedGroups=[...groups.values()].sort((a,b)=>a.id-b.id);
      expect(actualGroups,context+' groups').toEqual(expectedGroups);
      const actualServices=db.listServices().map(({id,name,slug,groupId,enabled,status})=>({id,name,slug,groupId,enabled,status})).sort((a,b)=>a.id-b.id);
      expect(actualServices,context+' services').toEqual([...services.values()].sort((a,b)=>a.id-b.id));
      expect((db.db.prepare('SELECT COUNT(*) AS n FROM events').get() as {n:number}).n,context+' event count').toBe(events);
      expect(db.db.pragma('foreign_key_check'),context+' FK integrity').toEqual([]);
      expect(db.userCount(),context+' accounts').toBe(3);
      const counts=db.overview().counts;
      expect(counts.total,context+' overview total').toBe(services.size);
      for(const status of ['healthy','degraded','offline','unknown'] as const)expect(counts[status],context+' '+status).toBe([...services.values()].filter(row=>row.status===status).length);
    };
    for(let step=0;step<1000;step++){
      probe.mockReset();probe.mockResolvedValue(204); // Denied checks never consume a queued per-call fixture.
      if(step%100===0)for(const actor of actors){db.db.prepare('UPDATE users SET role=? WHERE id=?').run(actor.defaultRole,actor.id);actor.role=actor.defaultRole;}
      if(step%73===0&&step>0){const actor=actors[next()%actors.length]!;actor.role=choose(originalRoles)!;db.db.prepare('UPDATE users SET role=? WHERE id=?').run(actor.role,actor.id);roleTransitions++;}
      const actor=next()%5===0?undefined:actors[next()%actors.length]!;
      const operation=choose(['create-group','edit-group','delete-group','create-service','edit-service','delete-service','check-service','invalid-group','import','duplicate-import','invalid-id','read'])!;
      operationCounts[operation]=(operationCounts[operation]||0)+1;
      const actorLabel=actor?actor.label+' as '+actor.role:'anonymous';actorCounts[actorLabel]=(actorCounts[actorLabel]||0)+1;
      const isAdmin=actor?.role==='admin';const canWrite=isAdmin||actor?.role==='operator';
      let method:'GET'|'POST'|'PATCH'|'DELETE'='GET';let url='/api/services';let payload:unknown=undefined;
      let expected=actor?200:401;let commit:((body:any)=>void)|undefined;
      const group=pickGroup();const service=pickService();const suffix=String(step);
      switch(operation){
        case 'create-group':
          method='POST';url='/api/groups';payload={name:'Synthetic group '+suffix,slug:'model-group-'+suffix};expected=!actor?401:!canWrite?403:201;
          commit=body=>groups.set(body.group.id,{id:body.group.id,name:"Synthetic group "+suffix,slug:"model-group-"+suffix});break;
        case 'edit-group':
          method='PATCH';url='/api/groups/'+(group?.id??999999);payload={name:'Updated group '+suffix};expected=!actor?401:!canWrite?403:!group?404:200;
          commit=()=>{if(group)group.name='Updated group '+suffix;};break;
        case 'delete-group':
          method='DELETE';url='/api/groups/'+(group?.id??999999);payload={};expected=!actor?401:!isAdmin?403:200;
          commit=()=>{if(group){groups.delete(group.id);for(const row of services.values())if(row.groupId===group.id)row.groupId=null;}};break;
        case 'create-service':
          method='POST';url='/api/services';payload={name:'Synthetic 文 service '+suffix,slug:'model-service-'+suffix,groupId:group?.id??null,url:'https://model-'+suffix+'.audit.invalid/',enabled:next()%2===0};
          expected=!actor?401:!canWrite?403:201;
          commit=body=>{const row=body.service;services.set(row.id,{id:row.id,name:'Synthetic 文 service '+suffix,slug:'model-service-'+suffix,groupId:group?.id??null,enabled:(payload as {enabled:boolean}).enabled,status:'unknown'});};break;
        case 'edit-service':
          method='PATCH';url='/api/services/'+(service?.id??999999);payload={name:'Changed service '+suffix,groupId:group?.id??null};expected=!actor?401:!canWrite?403:!service?404:200;
          commit=()=>{if(service){service.name='Changed service '+suffix;service.groupId=group?.id??null;}};break;
        case 'delete-service':
          method='DELETE';url='/api/services/'+(service?.id??999999);payload={};expected=!actor?401:!isAdmin?403:200;
          commit=()=>{if(service)services.delete(service.id);};break;
        case 'check-service':{
          const code=choose([200,302,404,500,undefined]);if(code===undefined)probe.mockRejectedValueOnce(new Error('synthetic probe failure'));else probe.mockResolvedValueOnce(code);
          method='POST';url='/api/services/'+(service?.id??999999)+'/check';payload={};expected=!actor?401:!canWrite?403:!service?404:200;
          commit=()=>{if(service){service.status=code===undefined||code>=500?'offline':code<400?'healthy':'degraded';events++;}};break;}
        case 'invalid-group':
          method='PATCH';url='/api/services/'+(service?.id??999999);payload={groupId:999999};expected=!actor?401:!canWrite?403:!service?404:400;break;
        case 'import':
          method='POST';url='/api/import/sun-panel';payload={groups:[{name:'Imported '+suffix,slug:'model-import-'+suffix}],services:[{name:'Imported service '+suffix,slug:'model-import-'+suffix,url:'https://import-'+suffix+'.audit.invalid/',groupSlug:'model-import-'+suffix}]};
          expected=!actor?401:!isAdmin?403:200;
          commit=()=>{const groupRow=db.listGroups().find(row=>row.slug==='model-import-'+suffix)!;const serviceRow=db.listServices().find(row=>row.slug==='model-import-'+suffix)!;
            groups.set(groupRow.id,{id:groupRow.id,name:'Imported '+suffix,slug:'model-import-'+suffix});services.set(serviceRow.id,{id:serviceRow.id,name:'Imported service '+suffix,slug:'model-import-'+suffix,groupId:groupRow.id,enabled:true,status:'unknown'});events++;};break;
        case 'duplicate-import':
          method='POST';url='/api/import/sun-panel';payload={groups:[{name:'Duplicate first',slug:'dup-'+suffix},{name:'Duplicate second',slug:'dup-'+suffix}],services:[]};
          expected=!actor?401:!isAdmin?403:409;break;
        case 'invalid-id':
          method='PATCH';url='/api/services/'+choose(['0x1','1e0','01','+1','%201','NaN','Infinity','9007199254740993']);payload={name:'Must not alias'};expected=!actor?401:!canWrite?403:400;break;
        case 'read':
          url=choose(['/api/services','/api/groups','/api/overview','/api/events?limit=invalid','/api/tasks','/api/integrations'])!;expected=actor?200:401;break;
      }
      const context='seed=0x4e585553 step='+step+' '+actorLabel+' '+operation;
      const response=await api.inject({method,url,headers:{'content-type':'application/json',...(actor?{cookie:actor.cookie}:{})},payload});
      expect(response.statusCode,context+' '+response.body).toBe(expected);
      statusCounts[String(response.statusCode)]=(statusCounts[String(response.statusCode)]||0)+1;
      if(response.statusCode>=200&&response.statusCode<300)commit?.(response.json());
      checkState(context);
    }
    await mkdir('artifacts/extended-audit',{recursive:true});
    await writeFile('artifacts/extended-audit/security-model-coverage.json',JSON.stringify({seed:'0x4e585553',steps:1000,operationCounts,actorCounts,statusCounts,roleTransitions,finalGroups:groups.size,finalServices:services.size,finalEvents:events,invariants:['authorization','all seed records preserved unless authorized mutation','FK integrity','single transaction','role changes immediate','overview matches model','unknown health not fake success']},null,2));
  },30000);
});
