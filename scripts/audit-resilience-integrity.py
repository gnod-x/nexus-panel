#!/usr/bin/env python3
"""Read-only SQLite/WAL integrity evidence for an explicitly isolated nexus-audit project."""
import argparse, datetime, json, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument("--project",required=True);args=parser.parse_args()
if not args.project.startswith("nexus-audit-") or not all(c.isalnum() or c=="-" for c in args.project):
 raise SystemExit("Only an explicitly isolated nexus-audit-* project is allowed")
r=subprocess.run(["docker","compose","--env-file","/dev/null","-f",str(ROOT/"docker-compose.yml"),"-p",args.project,"ps","-q","nexus-panel"],capture_output=True,text=True,check=True,timeout=10,cwd=ROOT)
container=r.stdout.strip()
if not container:raise SystemExit("Isolated app container not found")
source="""import Database from 'better-sqlite3';import crypto from 'node:crypto';
const db=new Database('/data/nexus.db',{readonly:true,fileMustExist:true});
const check=db.pragma('integrity_check');const journalMode=db.pragma('journal_mode',{simple:true});
const data=db.transaction(()=>{
 const queries={users:'SELECT id,email,role,created_at FROM users ORDER BY id',sessions:'SELECT user_id,expires_at,created_at FROM sessions ORDER BY user_id,created_at',groups:'SELECT id,name,slug,color,sort_order,created_at FROM groups ORDER BY id',services:'SELECT id,group_id,name,slug,description,url,status,tags,created_at,updated_at FROM services ORDER BY id',events:'SELECT id,service_id,type,message,metadata,created_at FROM events ORDER BY id'};
 const counts={};const tableDigests={};
 for(const [name,query]of Object.entries(queries)){const rows=db.prepare(query).all();counts[name]=rows.length;tableDigests[name]=crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');}
 return {counts,tableDigests};
})();db.close();console.log(JSON.stringify({integrityOk:check.length===1&&check[0].integrity_check==='ok',journalMode,...data}));
"""
r=subprocess.run(["docker","exec","-i",container,"node","--input-type=module"],input=source,capture_output=True,text=True,check=True,timeout=20)
data={"at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"project":args.project,"readOnly":True,**json.loads(r.stdout)}
out=ROOT/"artifacts/extended-audit"/("resilience-integrity-"+datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")+".json")
out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(data,indent=2))
print(json.dumps({"evidence":str(out),**data},indent=2))
raise SystemExit(0 if data["integrityOk"] else 1)
