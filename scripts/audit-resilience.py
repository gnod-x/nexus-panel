#!/usr/bin/env python3
"""Cloud-only isolated resilience audit. No production credentials or response bodies recorded."""
import argparse, concurrent.futures, collections, datetime, http.cookies, json, math, os
from pathlib import Path
import secrets, shutil, signal, statistics, subprocess, tempfile, threading, time, urllib.request, urllib.error

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument("--minutes",type=float,default=60)
parser.add_argument("--image",default="nexus-panel:task-center")
parser.add_argument("--rps",type=float,default=1.5)
args=parser.parse_args()
if not 0<args.rps<=2 or not 0<args.minutes<=90: raise SystemExit("bounds: rps <= 2, minutes <= 90")
stamp=datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
project="nexus-audit-resilience-"+stamp.lower()
out=ROOT/"artifacts"/"extended-audit"
out.mkdir(parents=True,exist_ok=True)
prefix=out/("resilience-"+stamp)
events=open(str(prefix)+"-events.jsonl","a",buffering=1)
requests_file=open(str(prefix)+"-requests.jsonl","a",buffering=1)
samples_file=open(str(prefix)+"-resources.jsonl","a",buffering=1)
summary={"project":project,"image":args.image,"plannedMinutes":args.minutes,"rps":args.rps,"concurrency":2,"cases":[],"samples":[],"endpoints":{}}
lock=threading.Lock()
stop=threading.Event()
signal.signal(signal.SIGTERM,lambda *_:stop.set())
signal.signal(signal.SIGINT,lambda *_:stop.set())
env={**os.environ,"NEXUS_IMAGE":args.image,"NEXUS_PORT":"0","NEXUS_BIND_ADDRESS":"127.0.0.1","PUBLIC_ORIGIN":"","TASK_DEMO_MODE":"false","INTEGRATION_DEMO_MODE":"false","TASK_SNAPSHOT_PATH":"/data/task-snapshot.json","INTEGRATION_CONFIG_PATH":"/data/integrations.json"}
latencies=collections.defaultdict(list)
codes=collections.Counter()
errors=0
total=0
pending=set()
container=None
base=None
soak_started=None
last_request=0
password=secrets.token_urlsafe(24)
cookies={}
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def emit(kind,**data):
 row={"at":now(),"kind":kind,**data}
 events.write(json.dumps(row)+"\n")
 print(json.dumps(row),flush=True)
def cmd(argv,input=None,timeout=30,check=True):
 r=subprocess.run(argv,input=input,capture_output=True,text=True,timeout=timeout,env=env,cwd=ROOT)
 if check and r.returncode:raise RuntimeError("command_failed:"+argv[0]+":"+str(r.returncode))
 return r
def compose(p,*argv,**kw):return cmd(["docker","compose","--env-file","/dev/null","-f",str(ROOT/"docker-compose.yml"),"-p",p,*argv],**kw)
def request(path,method="GET",body=None,role="admin",paced=True,address=None,timeout=12):
 global last_request
 if paced:
  wait=.52-(time.monotonic()-last_request)
  if wait>0:time.sleep(wait)
  last_request=time.monotonic()
 headers={}
 if role and cookies.get(role):headers["Cookie"]=cookies[role]
 data=None
 if body is not None:data=json.dumps(body).encode();headers["Content-Type"]="application/json"
 req=urllib.request.Request((address or base)+path,data=data,headers=headers,method=method)
 started=time.monotonic()
 try:
  with urllib.request.urlopen(req,timeout=timeout) as r:status=r.status;raw=r.read(3*1024*1024);heads=r.headers
 except urllib.error.HTTPError as e:status=e.code;raw=e.read(2048);heads=e.headers
 value=json.loads(raw) if raw else None
 return status,value,heads,(time.monotonic()-started)*1000
def case(name,condition,**data):
 row={"name":name,"passed":bool(condition),**data};summary["cases"].append(row);emit("case",**row)
 if not condition:raise RuntimeError("assertion_failed:"+name)
def ready(p):
 address="http://"+compose(p,"port","nexus-panel","3000").stdout.strip()
 if not address.startswith("http://127.0.0.1:"):raise RuntimeError("nonloopback_port")
 deadline=time.monotonic()+35
 while time.monotonic()<deadline:
  try:
   if request("/api/health",role=None,paced=False,address=address,timeout=1)[0]==200:return address
  except Exception:pass
  time.sleep(.5)
 raise RuntimeError("readiness_deadline")
def exec_js(source,target=None):return cmd(["docker","exec","-i",target or container,"node","--input-type=module"],input=source,timeout=20)
def db_evidence(target=None):
 source="""import Database from 'better-sqlite3';import crypto from 'node:crypto';
 const db=new Database('/data/nexus.db',{readonly:true,fileMustExist:true});
 const integrity=db.pragma('integrity_check');
 const result=db.transaction(()=>{
 const names=['users','sessions','groups','services','events'];const counts={};const stable={};
 for(const table of names)counts[table]=db.prepare('SELECT count(*) AS n FROM '+table).get().n;
 stable.users=db.prepare('SELECT id,email,role,created_at FROM users ORDER BY id').all();
 stable.sessions=db.prepare('SELECT user_id,expires_at,created_at FROM sessions ORDER BY user_id,created_at').all();
 stable.groups=db.prepare('SELECT id,name,slug,color,sort_order,created_at FROM groups ORDER BY id').all();
 stable.services=db.prepare('SELECT id,group_id,name,slug,description,url,status,tags,created_at,updated_at FROM services ORDER BY id').all();
 stable.events=db.prepare('SELECT id,service_id,type,message,metadata,created_at FROM events ORDER BY id').all();
 return {counts,stableDigest:crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex')};
 })();db.close();
 console.log(JSON.stringify({...result,integrityOk:integrity.length===1&&integrity[0].integrity_check==='ok'}));
 """
 return json.loads(exec_js(source,target).stdout)

def write_json(filename,value):
 source="import fs from 'node:fs';fs.writeFileSync("+json.dumps(filename)+","+json.dumps(json.dumps(value))+");"
 exec_js(source)
def seed():
 source="""import {Store} from './dist/server/db.js';import {hashPassword} from './dist/server/security.js';
 const store=new Store('/data/nexus.db'); const pw=PASSWORD;
 for(const role of ['operator','viewer'])store.createUser('resilience-'+role+'@example.test',hashPassword(pw),role);
 store.transactionImmediate(()=>{const g=store.createGroup({name:'Synthetic audit directory',slug:'audit-directory'});
 for(let i=0;i<500;i++)store.createService({groupId:g.id,name:'Synthetic service '+i,slug:'audit-service-'+i,description:'Generated audit fixture',url:'https://example.test/synthetic/'+i,tags:['synthetic','audit'],sortOrder:i});
 for(let i=0;i<1000;i++)store.addEvent(null,'audit_fixture','Synthetic generated event',{sequence:i});});
 console.log(JSON.stringify({users:store.userCount(),services:store.listServices().length}));store.db.close();
 """.replace("PASSWORD",json.dumps(password))
 result=json.loads(exec_js(source).stdout)
 case("isolated_500_service_fixture",result["services"]==500)
def login(role,address=None):
 status,value,heads,_=request("/api/auth/login","POST",{"email":"resilience-"+role+"@example.test","password":password},None,address=address)
 case("login_"+role+("_restored" if address else ""),status==200)
 parsed=http.cookies.SimpleCookie();parsed.load(heads.get("Set-Cookie",""))
 cookies[role]="; ".join(k+"="+v.value for k,v in parsed.items())
def sample():
 pid=int(cmd(["docker","inspect","--format","{{.State.Pid}}",container]).stdout)
 process_ids=[pid]
 for parent in process_ids:
  try:process_ids.extend(int(child) for child in Path("/proc/"+str(parent)+"/task/"+str(parent)+"/children").read_text().split())
  except FileNotFoundError:pass
 rss=0;fds=0;threads=0;cpu_ticks=0
 for process_id in process_ids:
  status={}
  try:
   for line in Path("/proc/"+str(process_id)+"/status").read_text().splitlines():
    if ":" in line:
     key,value=line.split(":",1);status[key]=value.strip()
   rss+=int(status.get("VmRSS","0 kB").split()[0])/1024
   fds+=len(list(Path("/proc/"+str(process_id)+"/fd").iterdir()))
   threads+=int(status.get("Threads","0"))
   fields=Path("/proc/"+str(process_id)+"/stat").read_text().split(")",1)[1].split()
   cpu_ticks+=int(fields[11])+int(fields[12])
  except FileNotFoundError:pass
 meminfo={}
 for line in Path("/proc/meminfo").read_text().splitlines():
  key,value=line.split(":",1);meminfo[key]=int(value.strip().split()[0])
 state=json.loads(cmd(["docker","inspect","--format","{{json .State}}",container]).stdout)
 try:preview_ok=request("/api/health",role=None,paced=False,address="http://127.0.0.1:18085",timeout=2)[0]==200
 except Exception:preview_ok=False
 row={"at":now(),"elapsedSeconds":round(time.monotonic()-soak_started,1) if soak_started else 0,"rssMiB":round(rss,2),"fds":fds,"threads":threads,"processes":len(process_ids),"cpuSeconds":round(cpu_ticks/os.sysconf("SC_CLK_TCK"),2),"availableMiB":round(meminfo["MemAvailable"]/1024,1),"load1":os.getloadavg()[0],"oomKilled":state["OOMKilled"],"previewHealthy":preview_ok,"requests":total,"errors":errors}
 samples_file.write(json.dumps(row)+"\n");summary["samples"].append(row)
 if rss>330 or row["availableMiB"]<1024 or state["OOMKilled"] or not preview_ok:
  emit("safety_stop",**row);stop.set()
 return row
def worker(sequence):
 global errors,total
 paths=["/api/services","/api/tasks","/api/events?limit=200","/api/overview","/api/integrations","/api/groups","/api/auth/me","/api/tasks"]
 path=paths[sequence%len(paths)];method="GET";body=None
 if sequence%20==19:path="/api/groups/1";method="PATCH";body={"sortOrder":sequence%100000}
 role=["admin","viewer","operator"][sequence%3] if method=="GET" else "operator"
 started=time.monotonic()
 try:
  status,value,_,elapsed=request(path,method,body,role,paced=False)
  ok=status==200
  if path=="/api/services":ok=ok and len(value.get("services",[]))==500
  if path=="/api/tasks":ok=ok and len(value.get("snapshot",{}).get("tasks",[]))==1000
  record={"at":now(),"sequence":sequence,"path":path,"method":method,"status":status,"latencyMs":round(elapsed,3),"ok":ok}
 except Exception as e:
  elapsed=(time.monotonic()-started)*1000;ok=False;status=0
  record={"at":now(),"sequence":sequence,"path":path,"method":method,"status":status,"latencyMs":round(elapsed,3),"ok":False,"errorType":type(e).__name__}
 with lock:
  total+=1;errors+=not ok;latencies[path].append(elapsed);codes[str(status)]+=1
  requests_file.write(json.dumps(record)+"\n")
  if total>=50 and errors/total>.02:emit("error_rate_stop",requests=total,errors=errors);stop.set()
def freshness_evidence(value):
 return {"mode":value["mode"],"snapshotFreshness":value["freshness"],"collectionAgeSeconds":round((datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(value["observedAt"].replace("Z","+00:00"))).total_seconds(),3),"sourceCount":len(value["sources"]),"sourceFreshness":dict(collections.Counter(row["freshness"] for row in value["sources"])),"taskCount":len(value["tasks"]),"taskFreshness":dict(collections.Counter(row["freshness"] for row in value["tasks"]))}
def percentile(values,p):
 ordered=sorted(values);return round(ordered[min(len(ordered)-1,math.ceil(p*len(ordered))-1)],3) if values else None
try:
 emit("setup",project=project,plannedMinutes=args.minutes,rps=args.rps,outputPrefix=str(prefix))
 compose(project,"up","-d","--no-build","--pull","never",timeout=60)
 container=compose(project,"ps","-q","nexus-panel").stdout.strip()
 summary["imageId"]=cmd(["docker","inspect","--format","{{.Image}}",container]).stdout.strip()
 base=ready(project)
 hard=json.loads(cmd(["docker","inspect","--format","{{json .HostConfig}}",container]).stdout)
 user=cmd(["docker","inspect","--format","{{.Config.User}}",container]).stdout.strip()
 case("container_hardening",hard["ReadonlyRootfs"] and hard["Memory"]==384*1024**2 and hard["PidsLimit"]==128 and "ALL" in hard["CapDrop"] and user=="node")
 root=cmd(["docker","exec",container,"node","-e","require('node:fs').writeFileSync('/audit-readonly-probe','x')"],check=False)
 case("readonly_root_write_rejected",root.returncode!=0)
 for endpoint in ["tasks","integrations","services"]:case("unauth_"+endpoint,request("/api/"+endpoint,role=None)[0]==401)
 case("clean_bootstrap",request("/api/auth/bootstrap","POST",{"email":"resilience-admin@example.test","password":password},None)[0]==201)
 login("admin")
 for endpoint in ["tasks","integrations"]:
  value=request("/api/"+endpoint)[1]["snapshot"];case("default_unconfigured_"+endpoint,value["mode"]=="unconfigured")
 seed();login("viewer");login("operator")
 case("viewer_cannot_write",request("/api/groups","POST",{"name":"Denied fixture","slug":"denied-fixture"},"viewer")[0]==403)
 case("operator_cannot_delete",request("/api/groups/1","DELETE",{},"operator")[0]==403)
 case("viewer_tasks_read",request("/api/tasks",role="viewer")[0]==200)
 write_json("/data/task-snapshot.json",{"invalid":True})
 snap=request("/api/tasks")[1]["snapshot"];case("malformed_task_snapshot",not snap["tasks"] and snap["sources"][0]["error"]=="snapshot_invalid")
 write_json("/data/integrations.json",{"invalid":True})
 snap=request("/api/integrations")[1]["snapshot"];case("malformed_integration_config",all(c["errorCode"]=="config_invalid" for c in snap["connections"]))
 write_json("/data/integrations.json",{"version":1,"connections":[]})
 at=now()
 task={"id":"fixture-0","sourceId":"fixture","name":"Synthetic task","serviceName":"Synthetic audit","kind":"cron","schedule":"0 * * * *","timezone":"UTC","enabled":True,"state":"unknown","lastStartedAt":None,"lastFinishedAt":None,"durationMs":None,"exitCode":None,"nextRunAt":None,"nextRunKind":"unknown","sourceUpdatedAt":None,"observedAt":at}
 snapshot={"version":1,"mode":"live","observedAt":at,"sources":[{"id":"fixture","name":"Synthetic audit snapshot","kind":"snapshot","status":"ok","completeness":"partial","observedAt":at}],"tasks":[{**task,"id":"fixture-"+str(i),"name":"Synthetic task "+str(i)} for i in range(1000)]}
 write_json("/data/task-snapshot.json",snapshot)
 initial_tasks=request("/api/tasks")[1]["snapshot"]
 case("max_1000_task_snapshot",len(initial_tasks["tasks"])==1000)
 summary["freshnessBeforeSoak"]=freshness_evidence(initial_tasks)
 case("task_snapshot_initially_fresh",summary["freshnessBeforeSoak"]["snapshotFreshness"]=="fresh" and summary["freshnessBeforeSoak"]["taskFreshness"]=={"fresh":1000})
 soak_started=time.monotonic()
 summary["startedAt"]=now();summary["container"]=container;summary["address"]=base
 emit("soak_started",startedAt=summary["startedAt"],expectedEnd=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=args.minutes)).isoformat(),container=container,address=base)
 next_sample=soak_started;next_report=soak_started+600;deadline=soak_started+args.minutes*60;sequence=0
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  while time.monotonic()<deadline and not stop.is_set():
   clock=time.monotonic()
   if clock>=next_sample:row=sample();next_sample+=60
   if clock>=next_report:emit("progress",elapsedSeconds=round(clock-soak_started),requests=total,errors=errors,rssMiB=row["rssMiB"],fds=row["fds"],previewHealthy=row["previewHealthy"]);next_report+=600
   pending={f for f in pending if not f.done()}
   for _ in range(max(0,2-len(pending))):
    pending.add(pool.submit(worker,sequence));sequence+=1
   # Pairs are spaced >1 second at <=2rps: two real concurrent requests, never >2/s.
   stop.wait(2/args.rps)
  concurrent.futures.wait(pending,timeout=20)
 summary["soakSeconds"]=round(time.monotonic()-soak_started,2)
 case("soak_deadline_completed",not stop.is_set() and summary["soakSeconds"]>=args.minutes*60)
 sample()
 summary["freshnessAfterSoak"]=freshness_evidence(request("/api/tasks")[1]["snapshot"])
 if args.minutes>=15:
  observed=summary["freshnessAfterSoak"]
  case("natural_production_clock_fresh_to_stale",observed["snapshotFreshness"]=="stale" and observed["sourceFreshness"]=={"stale":1} and observed["taskFreshness"]=={"stale":1000} and observed["collectionAgeSeconds"]>=900)
 database_before_restart=db_evidence()
 summary["databaseBeforeRestart"]=database_before_restart
 case("sqlite_integrity_before_restart",database_before_restart["integrityOk"])
 compose(project,"restart","-t","5",timeout=40);base=ready(project)
 case("restart_preserves_session_and_directory",len(request("/api/services")[1]["services"])==500)
 case("restart_preserves_snapshot",len(request("/api/tasks")[1]["snapshot"]["tasks"])==1000)
 database_before_backup=db_evidence()
 summary["databaseBeforeBackup"]=database_before_backup
 case("restart_preserves_all_database_evidence",database_before_backup==database_before_restart)
 compose(project,"stop","-t","5",timeout=30)
 work=Path(tempfile.mkdtemp(prefix="nexus-audit-resilience-",dir="/tmp"))
 try:
  backup=work/"backup.tgz"
  with backup.open("wb") as f:
   result=subprocess.run(["docker","run","--rm","--network","none","--user","0:0","-v",project+"_nexus_data:/data:ro",args.image,"tar","-czf","-","-C","/data","."],stdout=f,stderr=subprocess.DEVNULL,timeout=30)
   case("backup_archive_created",result.returncode==0 and backup.stat().st_size>0)
  restored=project+"-restore"
  compose(restored,"create","--no-build","--pull","never",timeout=30)
  with backup.open("rb") as f:
   result=subprocess.run(["docker","run","--rm","-i","--network","none","--user","0:0","-v",restored+"_nexus_data:/data",args.image,"tar","-xzf","-","-C","/data"],stdin=f,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
   case("backup_extract_new_volume",result.returncode==0)
  compose(restored,"start",timeout=30);restored_base=ready(restored)
  restored_container=compose(restored,"ps","-q","nexus-panel").stdout.strip()
  restored_database=db_evidence(restored_container)
  summary["databaseAfterRestore"]=restored_database
  case("restored_sqlite_integrity_and_all_evidence",restored_database["integrityOk"] and restored_database==database_before_backup)
  case("restored_existing_session_works",request("/api/auth/me",address=restored_base)[0]==200)
  login("admin",restored_base)
  case("restore_500_services",len(request("/api/services",address=restored_base)[1]["services"])==500)
  case("restore_1000_tasks",len(request("/api/tasks",address=restored_base)[1]["snapshot"]["tasks"])==1000)
  case("restore_event_history",len(request("/api/events?limit=200",address=restored_base)[1]["events"])==200)
 finally:
  compose(project+"-restore","down","-v",timeout=40,check=False)
  shutil.rmtree(work)
 summary["passed"]=True
except Exception as error:
 summary["passed"]=False;summary["failureType"]=type(error).__name__;summary["failure"]=str(error)[:160]
 emit("failure",errorType=type(error).__name__,message=str(error)[:160])
finally:
 summary["endedAt"]=now();summary["requests"]=total;summary["errors"]=errors;summary["statusCodes"]=dict(codes)
 for endpoint,values in latencies.items():summary["endpoints"][endpoint]={"count":len(values),"p50Ms":percentile(values,.50),"p95Ms":percentile(values,.95),"p99Ms":percentile(values,.99),"maxMs":round(max(values),3)}
 cleanup=compose(project,"down","-v",timeout=45,check=False)
 summary["cleanedUp"]=cleanup.returncode==0
 Path(str(prefix)+"-summary.json").write_text(json.dumps(summary,indent=2))
 emit("finished",passed=summary.get("passed"),requests=total,errors=errors,cleanedUp=summary["cleanedUp"],summary=str(prefix)+"-summary.json")
 events.close();requests_file.close();samples_file.close()
raise SystemExit(0 if summary.get("passed") and summary["cleanedUp"] else 1)
