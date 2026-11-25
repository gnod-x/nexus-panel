#!/usr/bin/env python3
"""Summarize bounded audit telemetry without reading any API response body."""
import argparse, collections, datetime, json, math, statistics
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument("prefix");args=parser.parse_args()
prefix=Path(args.prefix)
def records(suffix):
 p=Path(str(prefix)+suffix)
 return [json.loads(line) for line in p.read_text().splitlines() if line] if p.exists() else []
requests=records("-requests.jsonl");samples=records("-resources.jsonl");events=records("-events.jsonl")
def percentile(values,p):
 values=sorted(values);return round(values[min(len(values)-1,math.ceil(len(values)*p)-1)],3) if values else None
def metrics(rows):
 values=[row["latencyMs"] for row in rows]
 return {"count":len(rows),"errors":sum(not row["ok"] for row in rows),"p50Ms":percentile(values,.5),"p95Ms":percentile(values,.95),"p99Ms":percentile(values,.99),"maxMs":max(values) if values else None}
result={"sourcePrefix":str(prefix),"requestMetrics":metrics(requests),"statusCounts":dict(collections.Counter(row["status"] for row in requests)),"endpoints":{},"resourceSamples":len(samples),"safetyStops":[row for row in events if "stop" in row["kind"]]}
for path in sorted(set(row["path"] for row in requests)):result["endpoints"][path]=metrics([row for row in requests if row["path"]==path])
if len(samples)>1:
 elapsed=samples[-1]["elapsedSeconds"]-samples[0]["elapsedSeconds"]
 result["sampledSeconds"]=elapsed
 result["rssMiB"]={"min":min(s["rssMiB"] for s in samples),"max":max(s["rssMiB"] for s in samples),"firstFiveMean":round(statistics.mean(s["rssMiB"] for s in samples[:5]),2),"lastFiveMean":round(statistics.mean(s["rssMiB"] for s in samples[-5:]),2)}
 result["fds"]={"min":min(s["fds"] for s in samples),"max":max(s["fds"] for s in samples),"last":samples[-1]["fds"]}
 result["cpuMeanOneCorePercent"]=round((samples[-1]["cpuSeconds"]-samples[0]["cpuSeconds"])/elapsed*100,3)
 result["hostAvailableMinMiB"]=min(s["availableMiB"] for s in samples)
 result["allPreviewSamplesHealthy"]=all(s["previewHealthy"] for s in samples)
 result["oomObserved"]=any(s["oomKilled"] for s in samples)
 result["maxSampleGapSeconds"]=round(max(b["elapsedSeconds"]-a["elapsedSeconds"] for a,b in zip(samples,samples[1:])),2)
 result["errorRate"]=round(result["requestMetrics"]["errors"]/max(1,len(requests)),6)
if requests:
 stamps=[datetime.datetime.fromisoformat(row["at"]).timestamp() for row in requests]
 span=stamps[-1]-stamps[0]
 result["observedMeanRps"]=round((len(requests)-1)/span,4) if span else None
 result["maxCompletionGapSeconds"]=round(max((b-a for a,b in zip(stamps,stamps[1:])),default=0),3)
 starts=sorted(datetime.datetime.fromisoformat(row["at"]).timestamp()-row["latencyMs"]/1000 for row in requests)
 window=collections.deque();max_starts=0
 for started in starts:
  while window and started-window[0]>=1:window.popleft()
  window.append(started);max_starts=max(max_starts,len(window))
 result["maxStartsInAnySecond"]=max_starts
 changes=[]
 for row in requests:
  ended=datetime.datetime.fromisoformat(row["at"]).timestamp()
  changes.extend([(ended-row["latencyMs"]/1000,1),(ended,-1)])
 active=0;peak=0
 for _,change in sorted(changes):
  active+=change;peak=max(peak,active)
 result["inferredPeakConcurrentRequests"]=peak
result["generatedAt"]=datetime.datetime.now(datetime.timezone.utc).isoformat()
output=Path(str(prefix)+"-analysis.json");output.write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
