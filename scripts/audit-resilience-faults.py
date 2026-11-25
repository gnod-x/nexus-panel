#!/usr/bin/env python3
"""Disposable integration-fault/recovery matrix; only synthetic private Docker upstreams."""
import argparse, concurrent.futures, datetime, http.cookies, json, os, secrets, shutil, subprocess, tempfile, time, urllib.request, urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument("--image",required=True);parser.add_argument("--rps",type=float,default=.4);args=parser.parse_args()
if not 0<args.rps<=2:raise SystemExit("rps must be <=2")
stamp=datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
project="nexus-audit-faults-"+stamp.lower()
out=ROOT/"artifacts/extended-audit"/("resilience-faults-"+stamp+".json")
work=Path(tempfile.mkdtemp(prefix=project+"-",dir="/tmp"));work.chmod(0o755)
report={"image":args.image,"project":project,"startedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"cases":[]}
token=secrets.token_urlsafe(32);password=secrets.token_urlsafe(24);session=""
last=0
last_safety=0
env={**os.environ,"NEXUS_IMAGE":args.image,"NEXUS_BIND_ADDRESS":"127.0.0.1","NEXUS_PORT":"0","PUBLIC_ORIGIN":"","TASK_DEMO_MODE":"false","INTEGRATION_DEMO_MODE":"false","TASK_SNAPSHOT_PATH":"/run/nexus-audit/tasks.json","INTEGRATION_CONFIG_PATH":"/run/nexus-audit/integrations.json","HEALTH_ALLOWED_CIDRS":"172.16.0.0/12"}
def cmd(argv,timeout=45,check=True):
 r=subprocess.run(argv,capture_output=True,text=True,timeout=timeout,cwd=ROOT,env=env)
 if check and r.returncode:raise RuntimeError("command_failed:"+argv[0]+":"+str(r.returncode))
 return r
def compose(*argv,**kw):return cmd(["docker","compose","--env-file","/dev/null","-f",str(ROOT/"docker-compose.yml"),"-f",str(work/"compose.json"),"-p",project,*argv],**kw)
def case(name,ok,**fields):
 row={"name":name,"passed":bool(ok),**fields};report["cases"].append(row);print(json.dumps(row),flush=True)
 if not ok:raise RuntimeError("assertion_failed:"+name)
def call(path="/api/integrations",method="GET",body=None,authenticated=True):
 global last,session
 pause=1/args.rps-(time.monotonic()-last)
 if pause>0:time.sleep(pause)
 last=time.monotonic()
 headers={"Cookie":session} if authenticated else {}
 if body is not None:headers["Content-Type"]="application/json"
 request=urllib.request.Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
 started=time.monotonic()
 try:
  with urllib.request.urlopen(request,timeout=12) as r:status=r.status;raw=r.read(3*1024*1024);response_headers=r.headers
 except urllib.error.HTTPError as e:status=e.code;raw=e.read(2048);response_headers=e.headers
 return status,json.loads(raw),response_headers,round((time.monotonic()-started)*1000,2)
def safety():
 global last_safety
 if time.monotonic()-last_safety<60:return
 last_safety=time.monotonic()
 available=int(next(line.split()[1] for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemAvailable:")))/1024
 with urllib.request.urlopen("http://127.0.0.1:18085/api/health",timeout=2) as r:healthy=r.status==200
 if available<1024 or not healthy:raise RuntimeError("host_or_preview_safety_threshold")
 app=compose("ps","-q","nexus-panel").stdout.strip()
 state=json.loads(cmd(["docker","inspect","--format","{{json .State}}",app]).stdout)
 if state["OOMKilled"]:raise RuntimeError("app_oom_safety_threshold")
 init=state["Pid"];pids=[init];rss=0
 for pid in pids:
  try:
   pids.extend(int(child) for child in Path("/proc/"+str(pid)+"/task/"+str(pid)+"/children").read_text().split())
   rss+=int(next(line.split()[1] for line in Path("/proc/"+str(pid)+"/status").read_text().splitlines() if line.startswith("VmRSS:")))/1024
  except (FileNotFoundError,StopIteration):pass
 if rss>330:raise RuntimeError("app_rss_safety_threshold")
def config(name,kind="cfspeed",extra=None):
 connection={"id":"audit-"+name.replace("_","-"),"name":"Synthetic "+name,"kind":kind,"baseUrl":"http://audit-upstream:3000/"+name}
 if kind=="quark-vod":connection["tokenFile"]="/run/secrets/audit-token"
 if extra:connection.update(extra)
 (work/"integrations.next.json").write_text(json.dumps({"version":1,"connections":[connection]}))
 (work/"integrations.next.json").replace(work/"integrations.json")
def snapshot():
 status,value,_,elapsed=call()
 if status!=200:raise RuntimeError("integration_http_"+str(status))
 return value["snapshot"]["connections"][0],elapsed
def count():
 target=compose("ps","-q","audit-upstream").stdout.strip()
 r=cmd(["docker","exec",target,"node","-e","fetch('http://127.0.0.1:3000/audit-counts').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"])
 return json.loads(r.stdout)
server=r"""
import http from 'node:http';import fs from 'node:fs';
const counts={};let active=0;let peak=0;
const token=fs.readFileSync('/fixtures/token','utf8').trim();
const server=http.createServer((req,res)=>{
 if(req.url==='/audit-counts'){res.setHeader('content-type','application/json');res.end(JSON.stringify({counts,active,peak}));return;}
 const name=req.url.split('/')[1];counts[name]=(counts[name]||0)+1;active++;peak=Math.max(peak,active);
 res.on('close',()=>active--);
 const state=JSON.parse(fs.readFileSync('/fixtures/control.json','utf8'));
 const mode=name==='stable'?state.stable:name;
 if(mode==='denied'){res.writeHead(401).end();return;}
 if(mode==='forbidden'){res.writeHead(403).end();return;}
 if(mode==='failure'){res.writeHead(503).end();return;}
 if(mode==='redirect'){res.writeHead(302,{location:'/ok/api/results'}).end();return;}
 if(mode==='delay'){setTimeout(()=>{if(!res.destroyed)res.writeHead(200,{'content-type':'application/json'}).end('{}');},6000);return;}
 if(mode==='too_large'){res.writeHead(200,{'content-type':'application/json','content-length':600000}).end(' '.repeat(600000));return;}
 if(mode==='chunked_large'){res.writeHead(200,{'content-type':'application/json'});res.write(' '.repeat(300000));res.end(' '.repeat(300000));return;}
 if(mode==='html'){res.writeHead(200,{'content-type':'text/html'}).end('<html>synthetic</html>');return;}
 if(mode==='gzip'){res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'}).end('{}');return;}
 if(mode==='bad_json'){res.writeHead(200,{'content-type':'application/json'}).end('{not valid');return;}
 if(mode==='wrong_schema'){res.writeHead(200,{'content-type':'application/json'}).end('{"unexpected":true}');return;}
 const isVod=req.url.endsWith('/stats');
 if(isVod&&req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}
 if(!isVod&&req.headers.authorization){res.writeHead(403).end();return;}
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify(isVod?{done:42,pending:2,searching:3,found:4,saving:5,failed:1,plays:99}:
 {total_scanned:100,total_verified:70,jp_recommendations:[{},{}],us_recommendations:[{}],scanning:false,updated_at:new Date(Date.now()-1000).toISOString()}));
});
server.listen(3000,'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
"""
try:
 report["imageId"]=cmd(["docker","image","inspect","--format","{{.Id}}",args.image]).stdout.strip()
 print(json.dumps({"project":project,"imageId":report["imageId"],"rps":args.rps}),flush=True)
 (work/"upstream.mjs").write_text(server);(work/"token").write_text(token);(work/"control.json").write_text('{"stable":"ok"}')
 (work/"integrations.json").write_text('{"version":1,"connections":[]}')
 overlay={"services":{"nexus-panel":{"volumes":[str(work)+":/run/nexus-audit:ro",str(work/"token")+":/run/secrets/audit-token:ro"],"networks":["default","audit-internal"],"logging":{"driver":"json-file","options":{"max-size":"2m","max-file":"1"}}},"audit-upstream":{"image":args.image,"command":["node","/fixtures/upstream.mjs"],"volumes":[str(work)+":/fixtures:ro"],"read_only":True,"cap_drop":["ALL"],"security_opt":["no-new-privileges:true"],"mem_limit":"64m","cpus":0.15,"pids_limit":16,"healthcheck":{"disable":True},"networks":["audit-internal"],"logging":{"driver":"json-file","options":{"max-size":"1m","max-file":"1"}}}},"networks":{"audit-internal":{"internal":True}}}
 (work/"compose.json").write_text(json.dumps(overlay))
 compose("up","-d","--no-build","--pull","never",timeout=60)
 base="http://"+compose("port","nexus-panel","3000").stdout.strip()
 deadline=time.monotonic()+30
 while time.monotonic()<deadline:
  try:
   if call("/api/health",authenticated=False)[0]==200:break
  except Exception:pass
  time.sleep(.4)
 case("isolated_loopback",base.startswith("http://127.0.0.1:"))
 case("bootstrap",call("/api/auth/bootstrap","POST",{"email":"fault-fixture@example.test","password":password},False)[0]==201)
 status,_,headers,_=call("/api/auth/login","POST",{"email":"fault-fixture@example.test","password":password},False)
 case("login",status==200)
 parsed=http.cookies.SimpleCookie();parsed.load(headers.get("Set-Cookie",""));session="; ".join(k+"="+v.value for k,v in parsed.items())
 config("ok");connection,elapsed=snapshot();case("cfspeed_no_credentials",connection["status"]=="connected" and connection["freshness"]=="fresh" and len(connection["metrics"])==5,latencyMs=elapsed,status=connection["status"],freshness=connection["freshness"],errorCode=connection["errorCode"],metricCount=len(connection["metrics"]))
 config("vod","quark-vod");connection,elapsed=snapshot();case("quark_bearer_file",connection["status"]=="connected" and next(m["value"] for m in connection["metrics"] if m["key"]=="pending")==14,latencyMs=elapsed)
 for name,error in [("denied","permission_denied"),("forbidden","permission_denied"),("failure","unavailable"),("redirect","unavailable"),("delay","timeout"),("too_large","response_too_large"),("chunked_large","response_too_large"),("html","unsupported_data"),("gzip","unsupported_data"),("bad_json","unsupported_data"),("wrong_schema","unsupported_data")]:
  safety();config(name);connection,elapsed=snapshot()
  case("upstream_"+name,connection["status"]=="error" and connection["errorCode"]==error and not connection["metrics"],latencyMs=elapsed,errorCode=connection["errorCode"])
  if name=="delay":case("timeout_bounded",3500<=elapsed<6500,latencyMs=elapsed)
 counts=count()["counts"];case("redirect_not_followed",counts.get("redirect")==1 and counts.get("ok")==1)
 config("stable");first,_=snapshot();case("stable_initial_read",first["status"]=="connected")
 # Exercise bounded cache with continuous real read requests, then expiry/failure and recovery.
 (work/"control.next.json").write_text('{"stable":"failure"}')
 (work/"control.next.json").replace(work/"control.json")
 attempts=0;deadline=time.monotonic()+31
 while time.monotonic()<deadline:
  connection,_=snapshot();attempts+=1
  if time.monotonic()<deadline-2:case("cached_live_"+str(attempts),connection["status"]=="connected")
  safety()
 failed,_=snapshot()
 case("failed_refresh_retains_stale_metrics",failed["status"]=="error" and failed["errorCode"]=="unavailable" and failed["freshness"]=="stale" and failed["metrics"]==first["metrics"] and failed["observedAt"]==first["observedAt"] and failed["checkedAt"]!=first["checkedAt"],cacheWindowRequests=attempts)
 (work/"control.next.json").write_text('{"stable":"ok"}')
 (work/"control.next.json").replace(work/"control.json")
 deadline=time.monotonic()+31
 while time.monotonic()<deadline:connection,_=snapshot();safety()
 recovered,_=snapshot()
 case("upstream_recovers_after_cache_expiry",recovered["status"]=="connected" and recovered["freshness"]=="fresh" and recovered["observedAt"]!=first["observedAt"])
 # Reader must reject malformed and oversized files, then recover without a restart.
 (work/"integrations.json").write_text('not-json')
 connection,_=snapshot();case("broken_config_is_safe_error",connection["errorCode"]=="config_invalid")
 (work/"integrations.json").write_text(" "*70000)
 connection,_=snapshot();case("oversize_config_is_safe_error",connection["errorCode"]=="config_invalid")
 config("ok");connection,_=snapshot();case("config_recovers_without_restart",connection["status"]=="connected")
 report["passed"]=True
except Exception as error:
 report["passed"]=False;report["failureType"]=type(error).__name__;report["failure"]=str(error)[:160]
 print(json.dumps({"failureType":type(error).__name__,"failure":str(error)[:160]}),flush=True)
finally:
 cleaned=compose("down","-v",timeout=50,check=False)
 report["cleanedUp"]=cleaned.returncode==0
 report["endedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat()
 out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2))
 shutil.rmtree(work)
 print(json.dumps({"report":str(out),"passed":report.get("passed"),"cleanedUp":report["cleanedUp"]}),flush=True)
raise SystemExit(0 if report.get("passed") and report["cleanedUp"] else 1)
