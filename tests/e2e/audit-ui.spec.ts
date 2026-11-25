const evidenceRoot = process.env.E2E_ARTIFACT_ROOT || "artifacts/home-refresh";
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdir, appendFile } from "node:fs/promises";
import type { Service, Group } from "../../src/server/types";
import type { Task, TaskSnapshot } from "../../src/shared/tasks";
import type { IntegrationSnapshot } from "../../src/shared/integrations";

const stamp=new Date().toISOString();
type Role="viewer"|"operator"|"admin";
const service=(id:number,name="合成服务 Alpha "+id,overrides:Partial<Service>={}):Service=>({id,groupId:1,name,slug:"synthetic-"+id,description:"中文与 English description for synthetic audit",url:"https://example.invalid/audit-"+id,healthUrl:null,icon:null,tags:["测试","MixedCaseTag"],status:"unknown",latencyMs:null,lastCheckedAt:null,enabled:true,sortOrder:id,createdAt:stamp,updatedAt:stamp,...overrides});
const group:Group={id:1,name:"测试分组 Lab",slug:"synthetic-group",color:"#6e8cff",sortOrder:1,createdAt:stamp};
const task=(id:string,overrides:Partial<Task>={}):Task=>({id,sourceId:"source",name:"任务 "+id,serviceName:"Synthetic Archive",kind:"calendar",schedule:"daily",timezone:"Asia/Shanghai",enabled:true,state:"unknown",lastStartedAt:null,lastFinishedAt:null,durationMs:null,exitCode:null,nextRunAt:null,nextRunKind:"unknown",sourceUpdatedAt:null,observedAt:stamp,freshness:"fresh",...overrides});
const taskSnapshot=(overrides:Partial<TaskSnapshot>={}):TaskSnapshot=>({version:1,mode:"live",observedAt:stamp,freshness:"fresh",sources:[{id:"source",name:"Synthetic source",kind:"snapshot",status:"ok",completeness:"partial",observedAt:stamp,freshness:"fresh"}],tasks:[task("unknown")],...overrides});
const integrationSnapshot=(overrides:Partial<IntegrationSnapshot>={}):IntegrationSnapshot=>({version:1,mode:"live",observedAt:stamp,connections:[{id:"cfspeed",name:"CFSpeed",kind:"cfspeed",status:"connected",serviceSlug:"synthetic-1",observedAt:stamp,checkedAt:stamp,sourceUpdatedAt:null,freshness:"unknown",metrics:[{key:"scanned",label:"已扫描 IP",value:1500,unit:"个"}],errorCode:null}],available:[{kind:"cfspeed",name:"CFSpeed",summary:"只读",authentication:"none"}],...overrides});
type State={role:Role;services:Service[];groups:Group[];tasks:TaskSnapshot;integrations:IntegrationSnapshot;fail:Record<string,{status:number;error:string}>;hold:Record<string,Promise<void>|undefined>;counts:Record<string,number>;requests:{path:string;method:string}[];authenticated:boolean};
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};}
async function fixture(page:Page, overrides:Partial<State>={},waitDirectory=true,authReady=true){
 const state:State={role:"admin",services:[service(1),service(2,"Offline Service",{status:"offline"})],groups:[group],tasks:taskSnapshot(),integrations:integrationSnapshot(),fail:{},hold:{},counts:{},requests:[],authenticated:true,...overrides};
 await page.route("**/api/**",async(route:Route)=>{
  const path=new URL(route.request().url()).pathname;const method=route.request().method();const key=method+" "+path;
  state.counts[key]=(state.counts[key]||0)+1;state.requests.push({path,method});
  if(state.hold[key])await state.hold[key];
  if(state.fail[key]){await route.fulfill({status:state.fail[key]!.status,contentType:"application/json",body:JSON.stringify({error:state.fail[key]!.error})});return;}
  let payload:unknown={};let status=200;
  if(path==="/api/auth/status")payload={bootstrapped:true};
  else if(path==="/api/auth/me"){status=state.authenticated?200:401;payload=state.authenticated?{user:{id:1,email:"synthetic-audit@example.invalid",role:state.role,createdAt:stamp}}:{error:"unauthorized"};}
  else if(path==="/api/auth/logout"){state.authenticated=false;payload={ok:true};}
  else if(path==="/api/auth/login"){state.authenticated=true;payload={user:{id:1,email:"synthetic-audit@example.invalid",role:state.role,createdAt:stamp}};}
  else if(path==="/api/services"&&method==="GET")payload={services:state.services};
  else if(path==="/api/groups"&&method==="GET")payload={groups:state.groups};
  else if(path==="/api/events")payload={events:[]};
  else if(path==="/api/settings")payload={homeFont:"calligraphy"};
  else if(path==="/api/tasks")payload={snapshot:state.tasks};
  else if(path==="/api/integrations")payload={snapshot:state.integrations};
  else if(path.match(/^\/api\/services\/\d+\/check$/)){const id=Number(path.split("/")[3]);const found=state.services.find(s=>s.id===id)!;const updated={...found,status:"healthy",latencyMs:35,lastCheckedAt:stamp};state.services=state.services.map(s=>s.id===id?updated as Service:s);payload={service:updated};}
  else {status=404;payload={error:"unexpected_audit_request"};}
  await route.fulfill({status,contentType:"application/json",body:JSON.stringify(payload)});
 });
 await page.goto("/");if(authReady){await expect(page.getByRole("heading",{name:"工作台",exact:true})).toBeVisible();if(waitDirectory)await expect(page.locator("article.nexus-service-card")).toHaveCount(state.services.length);}else await expect(page.getByRole("heading",{name:"登录面板",exact:true})).toBeVisible();
 return state;
}
async function enterManagement(page:Page){
 if(!await page.locator(".admin-shell").count())await page.getByRole("button",{name:"进入管理",exact:true}).click();
}
async function openMenu(page:Page){
 await enterManagement(page);
 if(await page.getByRole("button",{name:/^打开导航(?:菜单)?$/}).isVisible() && await page.locator(".sidebar").getAttribute("role")!=="dialog")await page.getByRole("button",{name:/^打开导航(?:菜单)?$/}).click();
}
async function nav(page:Page,name:string|RegExp){
 if(name==="工作台"){if(!await page.locator(".website-shell").count()){await openMenu(page);await page.locator(".sidebar nav").getByRole("button",{name:"返回首页",exact:true}).click();}await expect(page.getByRole("heading",{name:"工作台",exact:true})).toBeVisible();return;}
 await openMenu(page);
 const target=name==="全部服务"?"服务管理":name==="添加分组"?"分组管理":name;
 await page.locator(".sidebar nav").getByRole("button",{name:typeof target==="string"&&["服务管理","收藏服务"].includes(target)?new RegExp("^"+target+"(?:\\s*(?:\\d+|—))?$"):target,exact:typeof target==="string"}).click();
 if(name==="添加分组")await page.getByRole("button",{name:"新建分组",exact:true}).click();
}
async function addService(page:Page){await enterManagement(page);await nav(page,"全部服务");await page.getByRole("button",{name:"添加服务",exact:true}).click();}
async function capture(page:Page,name:string){await mkdir(evidenceRoot,{recursive:true});await page.screenshot({path:evidenceRoot + '/browser-'+test.info().project.name+"-"+name+".png",fullPage:true,animations:"disabled"});}
async function noOverflow(page:Page){await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));const size=await page.evaluate(()=>({actual:document.documentElement.scrollWidth,viewport:innerWidth}));expect(size.actual).toBeLessThanOrEqual(size.viewport);}
async function enlarged(page:Page,selector:string){await page.locator(selector).evaluate(root=>{const entries=[...root.querySelectorAll("*")].map(element=>({element:element as HTMLElement,size:parseFloat(getComputedStyle(element).fontSize)}));entries.forEach(({element,size})=>element.style.fontSize=size*2+"px");});}
test.beforeAll(async()=>{await mkdir(evidenceRoot,{recursive:true});await appendFile(evidenceRoot + '/browser-events.ndjson',JSON.stringify({event:"run-start",at:new Date().toISOString()})+"\n");});
test.afterEach(async({page},info)=>{if(info.status!==info.expectedStatus&&!page.isClosed())await info.attach("focus-state",{body:JSON.stringify(await page.evaluate(()=>({active:document.activeElement?.outerHTML.slice(0,600),mainInert:(document.querySelector("main.main") as HTMLElement|null)?.inert,bodyOverflow:document.body.style.overflow,sidebarVisibility:document.querySelector(".sidebar")?getComputedStyle(document.querySelector(".sidebar")!).visibility:null,sidebarClass:document.querySelector(".sidebar")?.className}))),contentType:"application/json"});await appendFile(evidenceRoot + '/browser-events.ndjson',JSON.stringify({event:"test-end",at:new Date().toISOString(),project:info.project.name,title:info.title,status:info.status,durationMs:info.duration})+"\n");});

test.describe("extended browser audit",()=>{

test("真实内存数据库：管理员创建编辑删除、收藏slug迁移、分组删除和导入回滚",async({page,baseURL})=>{
 test.skip(!baseURL?.endsWith(":4274"),"Real CRUD is isolated to the audit memory database.");
 await page.goto("/");await page.getByLabel("邮箱",{exact:true}).fill("browser-audit@example.invalid");await page.getByLabel("密码",{exact:true}).fill("synthetic audit only password");await page.getByRole("button",{name:"创建管理员",exact:true}).click();await expect(page.getByRole("heading",{name:"工作台",exact:true})).toBeVisible();
 await nav(page,"添加分组");await page.getByLabel("分组名称").fill("审计分组 / Lab");await page.getByLabel("分组标识符").fill("browser-audit-group");await page.getByRole("button",{name:"保存分组",exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
 await addService(page);
 await page.getByLabel("名称",{exact:true}).fill("真实CRUD / Synthetic");await page.getByLabel("标识符",{exact:true}).fill("browser-audit-service");await page.getByLabel("访问地址",{exact:true}).fill("https://1.1.1.1/browser-audit");await page.getByLabel("标签",{exact:true}).fill("中文，English, English");await page.getByRole("combobox",{name:"分组",exact:true}).selectOption({label:"审计分组 / Lab"});await page.getByRole("button",{name:"保存服务",exact:true}).click();
 const detail=page.getByRole("dialog",{name:"真实CRUD / Synthetic",exact:true});await expect(detail).toBeVisible();await expect(detail.locator(".tags span")).toHaveText(["中文","English"]);await detail.getByRole("button",{name:"收藏服务",exact:true}).click();await detail.getByRole("button",{name:"编辑",exact:true}).click();
 await page.getByLabel("名称",{exact:true}).fill("已编辑 / Edited");await page.getByLabel("标识符",{exact:true}).fill("browser-audit-renamed");await page.getByRole("button",{name:"保存服务",exact:true}).click();
 await expect(page.getByRole("dialog",{name:"已编辑 / Edited",exact:true})).toBeVisible();expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("nexus-favorites")||"[]"))).toContain("browser-audit-renamed");expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("nexus-favorites")||"[]"))).not.toContain("browser-audit-service");
 await page.getByRole("button",{name:"关闭服务详情",exact:true}).click();await page.reload();await expect(page.locator(".service-row")).toHaveCount(1);await page.locator(".service-row").click();await expect(page.getByRole("button",{name:"取消收藏",exact:true})).toBeVisible();await page.keyboard.press("Escape");
 await nav(page,"导入数据");
 const importDialog=page.getByRole("dialog",{name:"导入 Sun-Panel",exact:true});await importDialog.getByLabel("导入文件").setInputFiles({name:"audit-duplicate.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({groups:[{name:"Must rollback",slug:"browser-audit-rollback"}],services:[{name:"Duplicate",slug:"browser-audit-renamed",url:"https://1.1.1.1/duplicate"}]}))});await importDialog.getByRole("button",{name:"确认导入",exact:true}).click();await expect(importDialog.getByRole("alert")).toContainText("标识符已存在");
 const groups=await (await page.request.get("/api/groups")).json();expect(groups.groups.some((g:Group)=>g.slug==="browser-audit-rollback")).toBe(false);
 await importDialog.getByRole("button",{name:"关闭",exact:true}).click();
 await nav(page,"分组管理");await page.getByRole("button",{name:"编辑分组审计分组 / Lab",exact:true}).click();page.once("dialog",dialog=>dialog.accept());await page.getByRole("button",{name:"删除分组",exact:true}).click();
 const services=await(await page.request.get("/api/services")).json();expect(services.services[0].groupId).toBeNull();
 await nav(page,"全部服务");await page.locator(".service-row").click();page.once("dialog",dialog=>dialog.accept());await page.getByRole("button",{name:"删除",exact:true}).click();await expect(page.locator(".service-row")).toHaveCount(0);expect(await page.evaluate(()=>JSON.parse(localStorage.getItem("nexus-favorites")||"[]"))).not.toContain("browser-audit-renamed");
 await capture(page,"crud-cleaned");
});
for(const role of ["viewer","operator","admin"] as Role[]){
 test("权限展示与只读接入： "+role,async({page})=>{
  const state=await fixture(page,{role});
  await page.locator(".nexus-card-details").first().click();
  await expect(page.getByRole("dialog").getByRole("button",{name:/^(编辑|立即检查|删除)$/})).toHaveCount(0);await page.keyboard.press("Escape");
  await nav(page,"全部服务");await expect(page.getByRole("button",{name:"添加服务",exact:true})).toHaveCount(role==="viewer"?0:1);
  await page.locator(".service-row").first().click();const detail=page.getByRole("dialog");
  await expect(detail.getByRole("button",{name:"编辑",exact:true})).toHaveCount(role==="viewer"?0:1);await expect(detail.getByRole("button",{name:"立即检查",exact:true})).toHaveCount(role==="viewer"?0:1);await expect(detail.getByRole("button",{name:"删除",exact:true})).toHaveCount(role==="admin"?1:0);await page.keyboard.press("Escape");
  await nav(page,"分组管理");await expect(page.getByRole("button",{name:"新建分组",exact:true})).toHaveCount(role==="viewer"?0:1);
  if(role!=="viewer"){await page.getByRole("button",{name:"编辑分组"+group.name,exact:true}).click();await expect(page.getByRole("button",{name:"删除分组",exact:true})).toHaveCount(role==="admin"?1:0);await page.keyboard.press("Escape");}
  await nav(page,"任务中心");await expect(page.getByRole("heading",{name:"任务中心",exact:true})).toBeVisible();await expect(page.locator(".nexus-tasks").getByRole("button",{name:/运行|执行|删除|编辑|重启/})).toHaveCount(0);
  await nav(page,"服务接入");await expect(page.locator(".ni-integrations").getByRole("button",{name:/扫描|保存|切换|运行|执行|配置/})).toHaveCount(0);expect(state.requests.filter(r=>!["GET"].includes(r.method))).toEqual([]);
 });
}
test("手机导航选择、Escape与关闭按钮不遗留阻挡层",async({page})=>{
 await page.setViewportSize({width:320,height:740});await fixture(page);await enterManagement(page);
 await page.getByRole("button",{name:/^打开导航(?:菜单)?$/}).click();await expect(page.locator(".sidebar")).toBeVisible();await page.keyboard.press("Escape");await expect(page.locator(".sidebar")).toBeHidden();
 await nav(page,"任务中心");await expect(page.getByRole("heading",{name:"任务中心",exact:true})).toBeVisible();await expect(page.locator(".sidebar")).toBeHidden();
 await enterManagement(page);await page.getByRole("button",{name:/^打开导航(?:菜单)?$/}).click();await page.getByRole("button",{name:"关闭导航",exact:true}).click();await expect(page.locator(".sidebar")).toBeHidden();await noOverflow(page);await capture(page,"mobile-navigation");
});
test("首页无筛选栏，管理与命令面板中英搜索、收藏持久性和链接协议",async({page})=>{
 await fixture(page,{services:[service(1,"家庭媒体 / Media Vault"),service(2,"Unsafe placeholder",{url:"javascript:alert(1)"}),service(3,"Big Data",{tags:["MiXeDtag"]})]});
 await expect(page.locator(".nexus-home-search, .nexus-group-filters")).toHaveCount(0);
 await expect(page.locator("article.nexus-service-card")).toHaveCount(3);
 await expect(page.locator("a.nexus-service-open")).toHaveCount(2);await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
 await page.locator(".nexus-card-favorite").first().click();await page.reload();await expect(page.locator(".nexus-card-favorite").first()).toHaveAttribute("aria-pressed","true");
 await page.keyboard.press("Control+k");await expect(page.getByLabel("服务搜索关键词",{exact:true})).toBeFocused();await page.getByLabel("服务搜索关键词",{exact:true}).fill("media vault");await expect(page.locator(".command-results > button")).toHaveCount(1);await page.locator(".command-results > button").click();await expect(page.getByRole("dialog",{name:"家庭媒体 / Media Vault",exact:true})).toBeVisible();
 await page.keyboard.press("Escape");await nav(page,"全部服务");
 await page.locator("#global-search").fill("家庭");await expect(page.locator(".service-row")).toHaveCount(1);
 await page.locator("#global-search").fill("mixedTAG");await expect(page.locator(".service-row")).toHaveCount(1);await expect(page.locator(".service-row")).toContainText("Big Data");
});
test("键盘焦点：服务详情及命令面板限制焦点并恢复触发控件",async({page})=>{
 await fixture(page);const opener=page.locator(".nexus-card-details").first();await opener.focus();await page.keyboard.press("Enter");const dialog=page.getByRole("dialog");await expect(dialog).toBeVisible();
 for(let i=0;i<14;i++){await page.keyboard.press("Tab");const focus=await dialog.evaluate(element=>({inside:element.contains(document.activeElement),tag:document.activeElement?.tagName,html:document.activeElement?.outerHTML.slice(0,500)}));// Native modal Tab may visit browser chrome (BODY), but never an inert background control.
expect(focus.inside||focus.tag==="BODY",JSON.stringify(focus)).toBe(true);}
 await page.keyboard.press("Escape");await expect(opener).toBeFocused();
 const commandOpener=page.locator("a.nexus-service-open").first();await commandOpener.focus();await page.keyboard.press("Control+k");await expect(page.getByLabel("服务搜索关键词",{exact:true})).toBeFocused();await page.keyboard.press("Escape");await expect(commandOpener).toBeFocused();
});
test("表单错误保留输入、拒绝重复标识、取消不发保存请求",async({page})=>{
 const state=await fixture(page);state.fail["POST /api/services"]={status:409,error:"service_exists"};
 await addService(page);await page.getByLabel("名称",{exact:true}).fill("Audit form");await page.getByLabel("标识符",{exact:true}).fill("duplicate");await page.getByLabel("访问地址",{exact:true}).fill("https://example.invalid/audit");await page.getByRole("button",{name:"保存服务",exact:true}).click();await expect(page.getByRole("alert")).toContainText("标识符已存在");await expect(page.getByLabel("名称",{exact:true})).toHaveValue("Audit form");await expect(page.getByRole("button",{name:"保存服务",exact:true})).toBeEnabled();const count=state.counts["POST /api/services"];await page.getByRole("button",{name:"取消",exact:true}).click();expect(state.counts["POST /api/services"]).toBe(count);
});
test("导入：错误JSON、错误结构、超大文件不请求API，修正后可预览",async({page})=>{
 const state=await fixture(page);await nav(page,"导入数据");const input=page.getByLabel("导入文件");
 for(const content of ["broken {",JSON.stringify({groups:{},services:[]})]){
  await input.setInputFiles({name:"invalid.json",mimeType:"application/json",buffer:Buffer.from(content)});await expect(page.getByRole("alert")).toContainText("JSON 文件");await expect(page.getByRole("button",{name:"确认导入",exact:true})).toBeDisabled();
 }
 await input.setInputFiles({name:"large.json",mimeType:"application/json",buffer:Buffer.alloc(1024*1024+1," ")});await expect(page.getByRole("alert")).toContainText("不超过 1 MiB");
 await input.setInputFiles({name:"many.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({groups:Array.from({length:101},(_,i)=>({name:"Group "+i,slug:"group-"+i})),services:[]}))});await expect(page.getByRole("alert")).toContainText("100 个分组");
 await input.setInputFiles({name:"valid.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({groups:[],services:[]}))});await expect(page.getByRole("dialog").getByRole("status")).toContainText("0 个分组、0 个服务");await expect(page.getByRole("button",{name:"确认导入",exact:true})).toBeEnabled();expect(state.requests.some(r=>r.path==="/api/import/sun-panel")).toBe(false);
});

test("异步隔离：服务目录手动刷新晚响应不得跨退出再登录回写",async({page})=>{
 await fixture(page);const pending=gate();let requests=0;
 await page.route("**/api/services",async route=>{requests++;if(requests===1){await pending.promise;await route.fulfill({contentType:"application/json",body:JSON.stringify({services:[service(1,"旧会话目录 / OLD_SESSION")]})});}else await route.fulfill({contentType:"application/json",body:JSON.stringify({services:[service(9,"新会话目录 / NEW_SESSION")]})});});
 await nav(page,"全部服务");await page.getByRole("button",{name:"刷新数据",exact:true}).click();await expect.poll(()=>requests).toBe(1);
 await openMenu(page);await page.getByRole("button",{name:"退出登录",exact:true}).click();await expect(page.getByRole("heading",{name:"登录面板",exact:true})).toBeVisible();await page.getByLabel("邮箱",{exact:true}).fill("new-session@example.invalid");await page.getByLabel("密码",{exact:true}).fill("synthetic password");await page.getByRole("button",{name:"登录",exact:true}).click();await expect(page.locator("article.nexus-service-card")).toContainText("NEW_SESSION");
 const response=page.waitForResponse(r=>r.url().endsWith("/api/services"));pending.release();await(await response).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await capture(page,"late-directory-response");await expect(page.locator("article.nexus-service-card")).not.toContainText("OLD_SESSION");await expect(page.locator("article.nexus-service-card")).toContainText("NEW_SESSION");
});
test("异步隔离：健康检查晚响应不得污染新会话同id服务",async({page})=>{
 const state=await fixture(page);const pending=gate();state.hold["POST /api/services/1/check"]=pending.promise;
 await nav(page,"全部服务");await page.locator(".service-row").first().click();await page.getByRole("button",{name:"立即检查",exact:true}).click();await expect.poll(()=>state.counts["POST /api/services/1/check"]).toBe(1);await page.getByRole("button",{name:"关闭服务详情",exact:true}).click();
 await openMenu(page);await page.getByRole("button",{name:"退出登录",exact:true}).click();await expect(page.getByRole("heading",{name:"登录面板",exact:true})).toBeVisible();state.services=[service(1,"新账户服务 / CURRENT_USER")];await page.getByLabel("邮箱",{exact:true}).fill("second@example.invalid");await page.getByLabel("密码",{exact:true}).fill("synthetic password");await page.getByRole("button",{name:"登录",exact:true}).click();await nav(page,"全部服务");await expect(page.locator(".status-pill").first()).toContainText("未检查");
 const response=page.waitForResponse(r=>r.url().endsWith("/api/services/1/check"));pending.release();await(await response).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await capture(page,"late-check-response");await expect(page.locator(".status-pill").first()).toContainText("未检查");
});
test("退出登录返回登录页，再登录不复现旧弹窗",async({page})=>{
 await fixture(page);await page.locator(".nexus-card-details").first().click();await page.getByRole("button",{name:"关闭服务详情",exact:true}).click();
 await openMenu(page);await page.getByRole("button",{name:"退出登录",exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);await expect(page.locator(".app-shell")).toHaveCount(0);await page.getByLabel("邮箱",{exact:true}).fill("next@example.invalid");await page.getByLabel("密码",{exact:true}).fill("synthetic password");await page.getByRole("button",{name:"登录",exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("任务和接入晚响应在退出再登录后不能展示旧快照",async({page})=>{
 const state=await fixture(page);const taskGate=gate();const integrationGate=gate();let taskReads=0;let integrationReads=0;
 await page.route("**/api/tasks",async route=>{taskReads++;const data=taskSnapshot({tasks:[task(taskReads===1?"OLD_TASK":"NEW_TASK")]});if(taskReads===1)await taskGate.promise;await route.fulfill({contentType:"application/json",body:JSON.stringify({snapshot:data})});});
 await page.route("**/api/integrations",async route=>{integrationReads++;const data=integrationSnapshot();data.connections[0]!.metrics[0]!.value=integrationReads===1?111111:222222;if(integrationReads===1)await integrationGate.promise;await route.fulfill({contentType:"application/json",body:JSON.stringify({snapshot:data})});});
 await nav(page,"全部服务");await page.getByRole("button",{name:"刷新数据",exact:true}).click();await expect.poll(()=>taskReads).toBe(1);await expect.poll(()=>integrationReads).toBe(1);await openMenu(page);await page.getByRole("button",{name:"退出登录",exact:true}).click();await expect(page.getByRole("heading",{name:"登录面板",exact:true})).toBeVisible();await page.getByLabel("邮箱",{exact:true}).fill("next@example.invalid");await page.getByLabel("密码",{exact:true}).fill("synthetic password");await page.getByRole("button",{name:"登录",exact:true}).click();await nav(page,"任务中心");await expect(page.locator(".nt-task-list")).toContainText("NEW_TASK");
 const taskResponse=page.waitForResponse(r=>r.url().endsWith("/api/tasks"));taskGate.release();await(await taskResponse).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await expect(page.locator(".nt-task-list")).not.toContainText("OLD_TASK");await expect(page.locator(".nt-task-list")).toContainText("NEW_TASK");
 await nav(page,"服务接入");await expect(page.locator(".ni-metrics")).toContainText("222,222");const integrationResponse=page.waitForResponse(r=>r.url().endsWith("/api/integrations"));integrationGate.release();await(await integrationResponse).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await expect(page.locator(".ni-metrics")).not.toContainText("111,111");
 expect(state.authenticated).toBe(true);
});
test("独立加载：任务超时不阻塞工作台和接入页，失败重试保持可用",async({page})=>{
 const hold=gate();const state=await fixture(page,{hold:{"GET /api/tasks":hold.promise},fail:{"GET /api/tasks":{status:503,error:"synthetic_unavailable"}}});
 await expect(page.locator("article.nexus-service-card")).toHaveCount(2);await nav(page,"服务接入");await expect(page.locator(".ni-metrics")).toContainText("1,500");await nav(page,"任务中心");await expect(page.locator(".nexus-tasks")).toHaveAttribute("aria-busy","true");await expect(page.locator(".nt-header > button")).toBeDisabled();hold.release();await expect(page.locator(".nt-error")).toBeVisible();delete state.fail["GET /api/tasks"];await page.getByRole("button",{name:"重试读取任务",exact:true}).click();await expect(page.locator(".nt-task-list > li")).toHaveCount(1);
});
test("接入错误与任务错误均不泄漏后端正文，重试恢复",async({page})=>{
 const secret="SYNTHETIC_TOKEN_RAW_BODY_https://private.example.invalid/config";
 const state=await fixture(page,{fail:{"GET /api/tasks":{status:503,error:secret},"GET /api/integrations":{status:503,error:secret}}});
 await nav(page,"服务接入");await expect(page.getByRole("alert")).toContainText("无法读取服务接入信息");expect(await page.locator("body").innerHTML()).not.toContain(secret);delete state.fail["GET /api/integrations"];await page.getByRole("button",{name:"重新读取",exact:true}).click();await expect(page.locator(".ni-metrics")).toContainText("1,500");
 await nav(page,"任务中心");await expect(page.getByRole("alert")).toContainText("任务读取失败");expect(await page.locator("body").innerHTML()).not.toContain(secret);
});
for(const mode of ["demo","live","unconfigured"] as const){
 test("首页内嵌任务与管理任务中心保留模式及每条证据语义 "+mode,async({page})=>{
  await fixture(page,{tasks:taskSnapshot({mode,tasks:mode==="unconfigured"?[]:[task("failed",{state:"failed",exitCode:2}),task("stale-failed",{state:"failed",exitCode:3,freshness:"stale"})]})});
  await expect(page.locator(".nx-schedule-section .nt-embedded")).toBeVisible();
  await expect(page.locator(".nt-home-card")).toHaveCount(mode==="unconfigured"?0:2);
  await expect(page.locator(".nx-schedule-section").getByRole("button",{name:/运行|执行|删除|编辑|重启/})).toHaveCount(0);
  if(mode==="demo")await expect(page.locator(".nt-embedded-meta")).toContainText("演示数据");
  if(mode==="live")await expect(page.locator(".nt-home-card .nt-state-failed").first()).toContainText("上次失败");
  await nav(page,"任务中心");
  const view=page.locator(".nexus-tasks");await expect(view).toBeVisible();
  if(mode==="demo"){await expect(view).toContainText("演示数据");await expect(view).toContainText("未连接家庭服务");}
  else if(mode==="unconfigured"){await expect(view).toContainText("尚未接入任务来源");await expect(view.locator(".nt-task-row")).toHaveCount(0);}
  else {await expect(view.locator(".nt-state-failed").first()).toContainText("上次失败");await expect(view).toContainText("证据已过期");}
 });
}
test("管理任务中心快照过期或来源失败保留历史证据语义",async({page})=>{
 const state=await fixture(page,{tasks:taskSnapshot({freshness:"stale",tasks:[task("failed",{state:"failed",exitCode:2})]})});
 await expect(page.locator(".nx-schedule-section .nt-embedded")).toBeVisible();await nav(page,"任务中心");
 const view=page.locator(".nexus-tasks");await expect(view).toContainText("证据已过期");
 state.tasks=taskSnapshot({sources:[{id:"source",name:"Synthetic source",kind:"snapshot",status:"permission_denied",completeness:"unknown",observedAt:stamp,freshness:"fresh",error:"permission_denied"}],tasks:[task("failed",{state:"failed",exitCode:2})]});
 await view.locator(".nt-header > button").click();await expect.poll(()=>state.counts["GET /api/tasks"]).toBeGreaterThanOrEqual(2);await expect(view.locator(".nt-sources")).toContainText("权限不足");await expect(view.locator(".nt-sources")).toContainText("采集权限不足");
});
test("接入可定位已存在服务，缺失目录匹配仅显示通知",async({page})=>{
 const state=await fixture(page);await nav(page,"服务接入");await page.getByRole("button",{name:"查看 CFSpeed 服务详情",exact:true}).click();await expect(page.getByRole("dialog",{name:state.services[0]!.name,exact:true})).toBeVisible();await page.keyboard.press("Escape");state.integrations.connections[0]!.serviceSlug="missing-synthetic";await page.getByRole("button",{name:"刷新接入",exact:true}).click();await page.getByRole("button",{name:"查看 CFSpeed 服务详情",exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);await expect(page.locator(".toast")).toContainText("目录");
});

async function visibleControls(page:Page,scope:string){
 return page.locator(scope).evaluateAll(roots=>roots.flatMap(root=>[...root.querySelectorAll("button,input:not([type=hidden]),select,summary,a[href]")].filter(element=>{const b=element.getBoundingClientRect();return b.width>1&&b.height>1&&getComputedStyle(element).visibility!=="hidden";}).map(element=>{const b=element.getBoundingClientRect();return {name:element.getAttribute("aria-label")||element.textContent?.trim(),tag:element.tagName,width:b.width,height:b.height,font:parseFloat(getComputedStyle(element).fontSize)};})));
}
async function contrast(page:Page,selector:string){
 return page.locator(selector).evaluateAll(roots=>{
  const rgb=(s:string)=>{const n=s.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number)||[0,0,0];return /^color\(srgb\b/i.test(s)?[n[0]!*255,n[1]!*255,n[2]!*255,n[3]??1]:[n[0]!,n[1]!,n[2]!,n[3]??1];};
  const blend=(f:number[],b:number[])=>[...f.slice(0,3).map((v,i)=>v*f[3]!+b[i]!*(1-f[3]!)),1];
  const lum=(c:number[])=>c.slice(0,3).map(v=>{const t=v/255;return t<=.04045?t/12.92:((t+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i]!,0);
  return roots.flatMap(root=>[...root.querySelectorAll("*")].filter(e=>{const b=e.getBoundingClientRect();return b.width>3&&b.height>3&&getComputedStyle(e).visibility!=="hidden"&&[...e.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent?.trim());}).map(e=>{
   const style=getComputedStyle(e);let bg=[255,255,255,1];const chain:Element[]=[];for(let n:Element|null=e;n;n=n.parentElement)chain.push(n);chain.reverse().forEach(n=>bg=blend(rgb(getComputedStyle(n).backgroundColor),bg));const f=lum(blend(rgb(style.color),bg));const b=lum(bg);const min=parseFloat(style.fontSize)>=24?3:4.5;return {text:e.textContent?.trim().slice(0,60),ratio:(Math.max(f,b)+.05)/(Math.min(f,b)+.05),min};
  }));
 });
}
for(const theme of ["dark","light"]){
 test("综合布局与对比度：长英文中文、横屏、任务详情 "+theme,async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});await fixture(page,{groups:[{...group,name:"超长分组名称MixedEnglishWithoutAnyWhitespaceForLayoutAudit"}],services:[service(1,"AnExtremelyLongSyntheticServiceNameWithoutSpacesThatMustRemainReadable"),service(2,"用于验收的超长中文家庭服务名称以确保移动布局和键盘操作可用")],tasks:taskSnapshot({tasks:[task("long",{name:"AnExtremelyLongSyntheticTaskNameWithoutAnyWordBoundaryThatStillNeedsAccessibleDetails",serviceName:"AnExtremelyLongSyntheticAssociatedServiceNameWithoutAnyWordBoundaryForLayoutAudit",schedule:"0 30 12 * * MON-FRI"})]})});
  await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
  for(const width of [320,375,844,1440]){await page.setViewportSize({width,height:width===844?390:1000});await noOverflow(page);}
  const homeContrast=await contrast(page,".nexus-home");expect(homeContrast.filter(x=>x.ratio+.01<x.min)).toEqual([]);
  await nav(page,"任务中心");for(const width of [320,844,1440]){await page.setViewportSize({width,height:width===844?390:1000});await noOverflow(page);await page.locator(".nt-detail-button").click();await noOverflow(page);await expect(page.getByRole("dialog")).toBeVisible();await page.keyboard.press("Escape");}
  const taskContrast=await contrast(page,".nexus-tasks");expect(taskContrast.filter(x=>x.ratio+.01<x.min)).toEqual([]);
  await nav(page,"服务接入");const integrationContrast=await contrast(page,".ni-integrations");expect(integrationContrast.filter(x=>x.ratio+.01<x.min)).toEqual([]);await page.setViewportSize({width:320,height:900});await noOverflow(page);await capture(page,"long-layout-"+theme);
 });
 test("320px文字200%：目录、设置、服务详情和表单 "+theme,async({page})=>{
  await page.setViewportSize({width:320,height:900});await fixture(page,{services:[service(1,"ExtremelyLongNameWithoutSpacesForManagementAudit")]});await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
  await nav(page,"全部服务");await enlarged(page,".content");await noOverflow(page);await page.locator(".service-row").first().click();await noOverflow(page);await enlarged(page,".drawer");await noOverflow(page);await capture(page,"enlarged-drawer-"+theme);await page.keyboard.press("Escape");
  await nav(page,"设置");await enlarged(page,".settings-panel");await noOverflow(page);
  await nav(page,"工作台");await addService(page);await enlarged(page,".modal");await noOverflow(page);await page.getByRole("button",{name:"保存服务",exact:true}).scrollIntoViewIfNeeded();await expect(page.getByRole("button",{name:"保存服务",exact:true})).toBeInViewport();await capture(page,"enlarged-form-"+theme);await page.keyboard.press("Escape");
 });
}
test("所有主视图可操作区域44px与输入字号16px",async({page})=>{
 await page.setViewportSize({width:375,height:900});await fixture(page);const problems:unknown[]=[];
 for(const view of ["工作台","全部服务","任务中心","服务接入","设置"]){
  if(view!=="工作台")await nav(page,view);const controls=await visibleControls(page,".content");for(const item of controls){if(item.width<43.5||item.height<43.5)problems.push({view,...item});if(["INPUT","SELECT"].includes(item.tag)&&item.font<16)problems.push({view,reason:"input font below16",...item});}
 }
 expect(problems).toEqual([]);
});
test("减少动态：交互反馈与加载spinner不持续播放动画",async({page})=>{
 await page.emulateMedia({reducedMotion:"reduce"});await fixture(page);const hold=gate();await page.route("**/api/tasks",async route=>{await hold.promise;await route.fulfill({contentType:"application/json",body:JSON.stringify({snapshot:taskSnapshot()})});});
 await nav(page,"任务中心");await page.locator(".nt-header > button").click();await expect(page.locator(".nexus-tasks")).toHaveAttribute("aria-busy","true");
 const animations=await page.locator("body *").evaluateAll(elements=>elements.filter(e=>{const b=e.getBoundingClientRect();const s=getComputedStyle(e);return b.width>1&&b.height>1&&s.animationName!=="none"&&parseFloat(s.animationDuration)>.01;}).map(e=>({name:e.className,animation:getComputedStyle(e).animationName,duration:getComputedStyle(e).animationDuration})));hold.release();expect(animations).toEqual([]);
});
test("手机展开导航时键盘焦点不被侧栏遮挡",async({page})=>{
 await page.setViewportSize({width:375,height:800});await fixture(page);await enterManagement(page);const opener=page.getByRole("button",{name:/^打开导航(?:菜单)?$/});await opener.focus();await page.keyboard.press("Enter");await expect(page.locator(".sidebar")).toBeVisible();
 await expect.poll(()=>page.locator(".sidebar").evaluate(e=>e.contains(document.activeElement))).toBe(true);await page.keyboard.press("Escape");await expect(opener).toBeFocused();
});
test("同一任务零退出码和未知状态语义、估算和停用时间不混淆",async({page})=>{
 await fixture(page,{tasks:taskSnapshot({tasks:[task("unknown-exit",{state:"unknown",exitCode:null}),task("zero-exit",{state:"succeeded",exitCode:0,durationMs:0}),task("estimated",{state:"failed",exitCode:1,nextRunAt:"2026-11-22T00:00:00Z",nextRunKind:"estimated"}),task("disabled",{enabled:false,nextRunAt:"2026-11-21T00:00:00Z",nextRunKind:"authoritative"})]})});await nav(page,"任务中心");
 const unknown=page.locator(".nt-task-list > li").filter({has:page.getByRole("heading",{name:"任务 unknown-exit",exact:true})});await expect(unknown).toContainText("状态未知");await expect(unknown).not.toContainText("成功");await unknown.locator(".nt-detail-button").click();await expect(page.getByRole("dialog")).toContainText("未知；不能据此判断成功");await page.keyboard.press("Escape");
 const zero=page.locator(".nt-task-list > li").filter({has:page.getByRole("heading",{name:"任务 zero-exit",exact:true})});await zero.locator(".nt-detail-button").click();await expect(page.getByRole("dialog").locator(".nt-detail-facts > div").filter({has:page.locator("dt").getByText("退出码",{exact:true})}).locator("dd")).toHaveText("0");await page.keyboard.press("Escape");
 await expect(page.locator(".nt-task-list > li").filter({has:page.getByRole("heading",{name:"任务 estimated",exact:true})})).toContainText("估算时间，并非调度器确认");await expect(page.locator(".nt-task-list > li").filter({has:page.getByRole("heading",{name:"任务 disabled",exact:true})})).toContainText("已停用");
});


for(const [status,code,message] of [[401,"unauthorized","邮箱或密码不正确"],[403,"origin_forbidden","当前访问地址未被服务器允许"],[429,"rate_limited","尝试次数过多"],[500,"internal","认证服务暂时不可用"],[400,"invalid_input","请填写有效邮箱和密码"],[409,"already_bootstrapped","已经初始化，请登录"]] as const){
 test("认证失败中文反馈、表单保留和焦点 "+status,async({page})=>{
  await page.route("**/api/auth/status",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({bootstrapped:true})}));
  await page.route("**/api/auth/me",route=>route.fulfill({status:401,contentType:"application/json",body:JSON.stringify({error:"unauthorized"})}));
  await page.route("**/api/auth/login",route=>route.fulfill({status,contentType:"application/json",body:JSON.stringify({error:code})}));
  await page.goto("/");await page.getByLabel("邮箱",{exact:true}).fill("synthetic@example.invalid");await page.getByLabel("密码",{exact:true}).fill("password preserved");await page.getByRole("button",{name:"登录",exact:true}).click();const alert=page.locator(".nexus-auth-summary");await expect(alert).toContainText(message);await expect(alert).toBeFocused();await expect(page.getByLabel("邮箱",{exact:true})).toHaveValue("synthetic@example.invalid");await expect(page.getByLabel("密码",{exact:true})).toHaveValue("password preserved");await expect(page.getByRole("button",{name:"登录",exact:true})).toBeEnabled();
 });
}
test("认证初始加载与网络错误重试，不显示创建账户误导",async({page})=>{
 const pending=gate();let failed=true;
 await page.route("**/api/auth/status",async route=>{await pending.promise;if(failed)await route.abort("failed");else await route.fulfill({contentType:"application/json",body:JSON.stringify({bootstrapped:true})});});
 await page.route("**/api/auth/me",route=>route.fulfill({status:401,contentType:"application/json",body:JSON.stringify({error:"unauthorized"})}));
 await page.goto("/");await expect(page.getByRole("heading",{name:"正在连接你的空间",exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"创建管理员",exact:true})).toHaveCount(0);pending.release();await expect(page.getByRole("heading",{name:"面板暂不可用",exact:true})).toBeVisible();failed=false;await page.getByRole("button",{name:"重新连接",exact:true}).click();await expect(page.getByRole("heading",{name:"登录面板",exact:true})).toBeVisible();
});
test("HTML注入样例作为纯文本，不生成额外DOM或外部请求",async({page})=>{
 const payload='<img src=x onerror="window.syntheticInjected=true">';const urls:string[]=[];page.on("request",r=>urls.push(r.url()));
 await fixture(page,{services:[service(1,payload,{description:"<script>window.syntheticInjected=true</script>",icon:"<svg onload=alert(1)>",tags:[payload]})],groups:[{...group,name:payload}]});
 await expect(page.locator(".nexus-home")).toContainText(payload);await page.locator(".nexus-card-details").click();await expect(page.getByRole("dialog")).toContainText(payload);expect(await page.evaluate(()=>(window as unknown as Record<string,unknown>).syntheticInjected)).toBeUndefined();await expect(page.locator(".nexus-home img,.drawer img,.drawer script")).toHaveCount(0);expect(urls.filter(url=>!url.startsWith("http://127.0.0.1:4274/"))).toEqual([]);
});
test("浏览器时区与任务自己的时区独立，时间为空不伪造",async({browser})=>{
 const context=await browser.newContext({timezoneId:"Asia/Shanghai",viewport:{width:1280,height:900}});const page=await context.newPage();
 try{const timezoneSnapshot=integrationSnapshot();timezoneSnapshot.connections[0]!.observedAt="2026-11-20T18:00:00.000Z";timezoneSnapshot.connections[0]!.checkedAt="2026-11-20T18:00:00.000Z";await fixture(page,{integrations:timezoneSnapshot,tasks:taskSnapshot({tasks:[task("utc",{timezone:"UTC",lastStartedAt:"2026-11-20T18:00:00.000Z"})]})});await nav(page,"服务接入");await expect(page.locator(".ni-connection footer")).toContainText("浏览器时区");await expect(page.locator(".ni-connection footer")).toContainText("02:00");await expect(page.locator(".ni-connection footer")).not.toContainText("上游更新");await nav(page,"任务中心");await page.locator(".nt-detail-button").click();await expect(page.getByRole("dialog")).toContainText("18:00:00 UTC");await capture(page,"timezone-shanghai");}finally{await context.close();}
});
test("任务刷新失败保留历史证据，返回首页仍展示任务与失败提示",async({page})=>{
 const state=await fixture(page,{tasks:taskSnapshot({tasks:[task("failed",{state:"failed",exitCode:2})]})});await expect(page.locator(".nx-schedule-section .nt-embedded")).toBeVisible();await nav(page,"任务中心");state.fail["GET /api/tasks"]={status:503,error:"synthetic_failure"};await page.locator(".nt-header > button").click();await expect(page.locator(".nt-error")).toBeVisible();await expect(page.locator(".nt-task-list")).toContainText("任务 failed");await expect(page.locator(".nt-task-list")).toContainText(/过期|无法确认|上次/);await nav(page,"工作台");await expect(page.locator(".nx-schedule-section .nt-embedded")).toBeVisible();await expect(page.locator(".nx-schedule-section .nt-error")).toBeVisible();await expect(page.locator(".nt-home-card")).toContainText("任务 failed");await expect(page.locator("article.nexus-service-card")).toHaveCount(2);await capture(page,"task-refresh-failed");
});
test("接入刷新失败保留数据标不确定、无假新鲜且可恢复",async({page})=>{
 const state=await fixture(page);state.integrations.connections[0]!.freshness="fresh";await nav(page,"服务接入");await page.getByRole("button",{name:"刷新接入",exact:true}).click();await expect(page.getByText("最近成功读取的指标",{exact:true})).toBeVisible();state.fail["GET /api/integrations"]={status:503,error:"synthetic_failure"};await page.getByRole("button",{name:"刷新接入",exact:true}).click();await expect(page.locator(".ni-error")).toBeVisible();await expect(page.locator(".ni-state")).toHaveText("状态待确认");await expect(page.locator(".ni-metric-note")).toContainText("已过期");await expect(page.locator(".ni-metrics")).toContainText("1,500");await capture(page,"integration-refresh-failed");delete state.fail["GET /api/integrations"];await page.getByRole("button",{name:"重新读取",exact:true}).click();await expect(page.locator(".ni-error")).toHaveCount(0);await expect(page.locator(".ni-state")).toHaveText("已连接");
});
test("多次快速任务刷新和接入刷新不会重复并发请求",async({page})=>{
 const state=await fixture(page);await nav(page,"任务中心");const pending=gate();state.hold["GET /api/tasks"]=pending.promise;const before=state.counts["GET /api/tasks"]||0;const refresh=page.locator(".nt-header > button");await refresh.click();await expect(refresh).toBeDisabled();await refresh.evaluate(button=>(button as HTMLButtonElement).click());expect(state.counts["GET /api/tasks"]).toBe(before+1);pending.release();await expect(refresh).toBeEnabled();
 await nav(page,"服务接入");const integration=gate();state.hold["GET /api/integrations"]=integration.promise;const count=state.counts["GET /api/integrations"]||0;const button=page.locator(".ni-header button");await button.click();await expect(button).toBeDisabled();await button.evaluate(element=>(element as HTMLButtonElement).click());expect(state.counts["GET /api/integrations"]).toBe(count+1);integration.release();await expect(button).toBeEnabled();
});


test("移动导航Tab圈定、关闭恢复和跨断点清理inert与滚动锁",async({page})=>{
 await page.setViewportSize({width:375,height:800});await fixture(page);await enterManagement(page);const opener=page.getByRole("button",{name:/^打开导航(?:菜单)?$/});await opener.focus();await page.keyboard.press("Enter");const dialog=page.getByRole("dialog",{name:"导航",exact:true});await expect(dialog).toBeVisible();expect(await page.locator(".sidebar").evaluate(e=>(e as HTMLElement).inert)).toBe(false);await expect(page.getByRole("button",{name:"关闭导航",exact:true})).toBeFocused();
 expect(await page.locator("main.main").evaluate(e=>(e as HTMLElement).inert)).toBe(true);expect(await page.evaluate(()=>document.body.style.overflow)).toBe("hidden");
 for(let i=0;i<24;i++){await page.keyboard.press("Tab");expect(await dialog.evaluate(e=>e.contains(document.activeElement))).toBe(true);}
 await page.getByRole("button",{name:"关闭导航",exact:true}).focus();await page.keyboard.press("Shift+Tab");await expect(page.getByRole("button",{name:"退出登录",exact:true})).toBeFocused();await page.keyboard.press("Escape");await expect(opener).toBeFocused();expect(await page.locator(".sidebar").evaluate(e=>(e as HTMLElement).inert)).toBe(true);expect(await page.locator("main.main").evaluate(e=>(e as HTMLElement).inert)).toBe(false);
 await opener.click();await page.setViewportSize({width:1200,height:800});await expect(page.locator(".sidebar")).toHaveClass(/open/);await expect(page.locator("main.main")).toHaveJSProperty("inert",false);expect(await page.evaluate(()=>document.body.style.overflow)).not.toBe("hidden");await page.locator("#global-search").focus();await expect(page.locator("#global-search")).toBeFocused();
 await page.setViewportSize({width:375,height:800});await expect(opener).toHaveAttribute("aria-expanded","false");await opener.click();await expect(dialog).toBeVisible();await page.getByRole("button",{name:"关闭导航",exact:true}).click();await expect(opener).toBeFocused();await noOverflow(page);
});
test("移动导航启动管理弹窗、详情切换编辑不会抢走新modal焦点",async({page})=>{
 await page.setViewportSize({width:375,height:800});await fixture(page);await nav(page,"添加分组");const groupDialog=page.getByRole("dialog",{name:"添加分组",exact:true});await expect(groupDialog).toBeVisible();expect(await groupDialog.evaluate(e=>e.contains(document.activeElement))).toBe(true);await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"新建分组",exact:true})).toBeFocused();
 await nav(page,"全部服务");await page.locator(".service-row").first().click();await page.getByRole("button",{name:"编辑",exact:true}).click();const serviceDialog=page.getByRole("dialog",{name:"编辑服务",exact:true});await expect(serviceDialog).toBeVisible();expect(await serviceDialog.evaluate(e=>e.contains(document.activeElement))).toBe(true);await page.keyboard.press("Escape");await expect(page.getByRole("dialog")).toHaveCount(0);
});
async function capacityEvidence(page:Page,stage:string,start:number){
 await appendFile(evidenceRoot + '/browser-capacity.ndjson',JSON.stringify({at:new Date().toISOString(),engine:test.info().project.name,stage,elapsedMs:Date.now()-start,...await page.evaluate(()=>({domElements:document.querySelectorAll("*").length,serviceCards:document.querySelectorAll("article.nexus-service-card").length,taskRows:document.querySelectorAll(".nt-task-list > li").length,viewport:innerWidth}))})+"\n");
}
test("容量：500服务首屏、长列表滚动、搜索和320px详情",async({page})=>{
 test.setTimeout(45000);const services=Array.from({length:500},(_,i)=>service(i+1,"Capacity Service "+String(i).padStart(4,"0")));let start=Date.now();await fixture(page,{services});await expect(page.locator("article.nexus-service-card")).toHaveCount(500);await capacityEvidence(page,"500 services initial visible",start);
 await page.locator(".nexus-card-details").last().scrollIntoViewIfNeeded();await page.locator(".nexus-card-details").last().click();await expect(page.getByRole("dialog",{name:"Capacity Service 0499",exact:true})).toBeVisible();await page.keyboard.press("Escape");
 start=Date.now();await page.keyboard.press("Control+k");await page.getByLabel("服务搜索关键词",{exact:true}).fill("Capacity Service 0499");await expect(page.locator(".command-results > button")).toHaveCount(1);await capacityEvidence(page,"500 services search one",start);await page.locator(".command-results > button").click();await expect(page.getByRole("dialog",{name:"Capacity Service 0499",exact:true})).toBeVisible();await page.keyboard.press("Escape");
 await page.setViewportSize({width:320,height:900});await noOverflow(page);await page.locator(".nexus-card-details").last().scrollIntoViewIfNeeded();await page.locator(".nexus-card-details").last().click();await expect(page.getByRole("dialog",{name:"Capacity Service 0499",exact:true})).toBeVisible();await noOverflow(page);await page.screenshot({path:evidenceRoot + '/browser-'+test.info().project.name+"-capacity-service.png",fullPage:false,animations:"disabled"});await page.keyboard.press("Escape");
});
test("容量：1000任务切换、滚动、组合筛选与320px只读详情",async({page})=>{
 test.setTimeout(45000);const tasks=Array.from({length:1000},(_,i)=>task("capacity-"+String(i).padStart(4,"0"),{name:"Capacity Task "+String(i).padStart(4,"0"),serviceName:i%2?"Capacity Media":"Capacity Archive",state:i%5===0?"failed":"unknown",exitCode:i%5===0?1:null}));await fixture(page,{tasks:taskSnapshot({tasks})});let start=Date.now();await nav(page,"任务中心");await expect(page.locator(".nt-task-list > li")).toHaveCount(1000);await capacityEvidence(page,"1000 tasks switch",start);
 await page.locator(".nt-detail-button").last().scrollIntoViewIfNeeded();await page.locator(".nt-detail-button").last().click();await expect(page.getByRole("dialog")).toContainText("Capacity Task 0999");await page.keyboard.press("Escape");
 start=Date.now();await page.getByLabel("搜索任务",{exact:true}).fill("Capacity Task 0999");await page.getByLabel("按服务筛选任务",{exact:true}).selectOption("Capacity Media");await expect(page.locator(".nt-task-list > li")).toHaveCount(1);await capacityEvidence(page,"1000 tasks combined search",start);
 await page.setViewportSize({width:320,height:900});await noOverflow(page);await page.locator(".nt-detail-button").click();await noOverflow(page);await expect(page.getByRole("dialog")).toContainText("未知；不能据此判断成功");await page.screenshot({path:evidenceRoot + '/browser-'+test.info().project.name+"-capacity-task.png",fullPage:false,animations:"disabled"});await page.keyboard.press("Escape");await page.getByRole("button",{name:"清除筛选",exact:true}).click();await expect(page.locator(".nt-task-list > li")).toHaveCount(1000);await noOverflow(page);
});


test("初次目录读取慢时不能误报没有服务",async({page})=>{
 const pending=gate();const state=await fixture(page,{hold:{"GET /api/services":pending.promise}},false);
 try{await expect.poll(()=>state.counts["GET /api/services"]||0).toBe(1);await capture(page,"directory-initial-loading");await expect(page.getByRole("heading",{name:"还没有服务",exact:true})).toHaveCount(0);}finally{pending.release();}
 await expect(page.locator("article.nexus-service-card")).toHaveCount(2);
});
test("首批目录晚响应不能覆盖同会话更新的手动刷新",async({page})=>{
 const pending=gate();
 const state=await fixture(page,{hold:{"GET /api/services":pending.promise}},false);
 await expect.poll(()=>state.counts["GET /api/services"]||0).toBe(1);
 await page.route("**/api/services",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({services:[service(2,"REFRESH_NEW")]})}));
 await nav(page,"全部服务");await page.getByRole("button",{name:"刷新数据",exact:true}).click();await expect(page.locator(".service-row")).toContainText("REFRESH_NEW");
 const response=page.waitForResponse(r=>r.url().endsWith("/api/services"));pending.release();await(await response).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await expect(page.locator(".service-row")).toContainText("REFRESH_NEW");await expect(page.locator(".service-row")).not.toContainText("合成服务 Alpha");await nav(page,"工作台");await expect(page.locator("article.nexus-service-card")).toContainText("REFRESH_NEW");await expect(page.locator("article.nexus-service-card")).not.toContainText("合成服务 Alpha");
 expect(state.counts["GET /api/services"]).toBe(1);
});


test("目录初始503保留未知语义，重试成功后才显示真实空目录",async({page})=>{
 const state=await fixture(page,{services:[],fail:{"GET /api/services":{status:503,error:"synthetic_directory_unavailable"}}},false);
 await expect(page.locator(".toast[role=alert]")).toBeVisible();await expect(page.getByRole("heading",{name:"还没有服务",exact:true})).toHaveCount(0);await expect(page.getByText("请在“管理”中添加常用的网站和自托管服务。",{exact:true})).toHaveCount(0);
 await nav(page,"任务中心");await expect(page.locator(".nt-task-list > li")).toHaveCount(1);await nav(page,"工作台");delete state.fail["GET /api/services"];
 await page.locator(".nexus-home").getByRole("button",{name:/重试|重新读取/}).click();await expect(page.getByRole("heading",{name:"还没有服务",exact:true})).toBeVisible();await expect(page.getByText("请在“管理”中添加常用的网站和自托管服务。",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"进入管理",exact:true})).toBeVisible();await capture(page,"directory-retry-real-empty");
});
test("认证多字段错误摘要链接聚焦对应输入，201字符阻止请求而200空格原样提交",async({page})=>{
 let submitted:string|null=null;
 await page.route("**/api/auth/status",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({bootstrapped:true})}));await page.route("**/api/auth/me",route=>route.fulfill({status:401,contentType:"application/json",body:JSON.stringify({error:"unauthorized"})}));await page.route("**/api/auth/login",route=>{submitted=route.request().postDataJSON().password;return route.fulfill({status:401,contentType:"application/json",body:JSON.stringify({error:"unauthorized"})});});
 await page.goto("/");await page.getByLabel("邮箱",{exact:true}).fill("not-an-email");await page.getByRole("button",{name:"登录",exact:true}).click();const summary=page.locator(".nexus-auth-summary");await expect(summary).toBeFocused();await expect(summary.getByRole("link")).toHaveCount(2);await summary.getByRole("link").first().click();await expect(page.getByLabel("邮箱",{exact:true})).toBeFocused();await page.getByLabel("邮箱",{exact:true}).fill("synthetic@example.invalid");await page.getByLabel("密码",{exact:true}).fill("x".repeat(201));await page.getByRole("button",{name:"登录",exact:true}).click();await expect(page.getByLabel("密码",{exact:true})).toBeFocused();await expect(page.locator(".nexus-auth-field-error")).toContainText("200");expect(submitted).toBeNull();
 await page.getByLabel("密码",{exact:true}).fill(" ".repeat(200));await page.getByRole("button",{name:"登录",exact:true}).click();await expect.poll(()=>submitted).toBe(" ".repeat(200));await expect(page.getByLabel("密码",{exact:true})).toHaveValue(" ".repeat(200));
});
test("主题与收藏异常本地存储可恢复，深浅偏好跨刷新保持",async({page})=>{
 await page.addInitScript(()=>{if(!sessionStorage.getItem("synthetic-prepared")){localStorage.setItem("nexus-favorites","{not-valid-json");localStorage.setItem("nexus-theme","light");sessionStorage.setItem("synthetic-prepared","true");}});
 await fixture(page);await expect(page.locator("html")).toHaveAttribute("data-theme","light");await expect(page.locator(".nexus-card-favorite").first()).toHaveAttribute("aria-pressed","false");await enterManagement(page);await page.getByRole("button",{name:"切换主题",exact:true}).click();await expect(page.locator("html")).toHaveAttribute("data-theme","dark");await nav(page,"工作台");await page.reload();await expect(page.locator("html")).toHaveAttribute("data-theme","dark");await expect(page.locator("article.nexus-service-card")).toHaveCount(2);
});
test("退出失败不能伪装已退出，重试成功后清除服务数据",async({page})=>{
 const state=await fixture(page,{fail:{"POST /api/auth/logout":{status:503,error:"synthetic_logout_failure"}}});await openMenu(page);await page.getByRole("button",{name:"退出登录",exact:true}).click();await expect(page.locator(".toast[role=alert]")).toContainText("退出失败");await nav(page,"工作台");await expect(page.getByRole("heading",{name:"工作台",exact:true})).toBeVisible();await expect(page.locator("article.nexus-service-card")).toHaveCount(2);delete state.fail["POST /api/auth/logout"];await openMenu(page);await page.getByRole("button",{name:"退出登录",exact:true}).click();await expect(page.getByRole("heading",{name:"登录面板",exact:true})).toBeVisible();await expect(page.locator("article.nexus-service-card")).toHaveCount(0);
});



test("输入占位提示双主题对比度符合正文可读性",async({page})=>{
 await page.emulateMedia({reducedMotion:"reduce"});await fixture(page);const problems:unknown[]=[];
 for(const theme of ["dark","light"]){await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
  for(const view of ["工作台","全部服务","命令面板","服务表单"]){
   if(view==="工作台"||view==="全部服务")await nav(page,view);
   else if(view==="命令面板")await page.keyboard.press("Control+k");
   else {await addService(page);}
   const results=await page.locator("input[placeholder]").evaluateAll(inputs=>{
    const rgb=(value:string)=>{const n=value.match(/[\d.]+/g)?.map(Number)||[0,0,0];return[n[0]!,n[1]!,n[2]!,n[3]??1];};
    const blend=(f:number[],b:number[])=>[...f.slice(0,3).map((v,i)=>v*f[3]!+b[i]!*(1-f[3]!)),1];
    const lum=(c:number[])=>c.slice(0,3).map(v=>{const x=v/255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i]!,0);
    return inputs.filter(input=>{const box=input.getBoundingClientRect();return box.width>0&&box.height>0&&!(input as HTMLInputElement).value;}).map(input=>{let background=[255,255,255,1];const chain:Element[]=[];for(let e:Element|null=input;e;e=e.parentElement)chain.push(e);chain.reverse().forEach(e=>background=blend(rgb(getComputedStyle(e).backgroundColor),background));const style=getComputedStyle(input,"::placeholder");const color=rgb(style.color);color[3]!*=Number(style.opacity);const a=lum(blend(color,background)),b=lum(background);return {placeholder:input.getAttribute("placeholder"),color:style.color,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
   });problems.push(...results.filter(r=>r.ratio+.01<4.5).map(result=>({theme,view,...result})));
   if(view==="命令面板"||view==="服务表单")await page.keyboard.press("Escape");
  }
 }
 expect(problems).toEqual([]);
});

for(const scenario of [{method:"getItem",error:"SecurityError"},{method:"setItem",error:"SecurityError"},{method:"setItem",error:"QuotaExceededError"}] as const){
 test("存储不可用仍可登录与操作目录 "+scenario.method+" "+scenario.error,async({page})=>{
  const uncaught:string[]=[];page.on("pageerror",error=>uncaught.push(error.message));
  await page.addInitScript(({method,error})=>{
   const native=Storage.prototype[method];
   Object.defineProperty(Storage.prototype,method,{configurable:true,value:function(this:Storage,key:string,...rest:string[]){if(key.startsWith("nexus-"))throw new DOMException("Synthetic storage unavailable",error);return (native as (...args:string[])=>unknown).apply(this,[key,...rest]);}});
  },scenario);
  try{
   // Start logged out: browser storage restrictions must not prevent authentication.
   await fixture(page,{authenticated:false},false,false);await page.getByLabel("邮箱",{exact:true}).fill("synthetic-storage@example.invalid");await page.getByLabel("密码",{exact:true}).fill("synthetic password");await page.getByRole("button",{name:"登录",exact:true}).click();await expect(page.getByRole("heading",{name:"工作台",exact:true})).toBeVisible();await expect(page.locator("article.nexus-service-card")).toHaveCount(2);
   await page.locator(".nexus-card-favorite").last().click();await expect(page.locator(".nexus-card-favorite").first()).toHaveAttribute("aria-pressed","true");await expect(page.locator("article.nexus-service-card").first()).toContainText("Offline");await enterManagement(page);await page.getByRole("button",{name:"切换主题",exact:true}).click();await nav(page,"任务中心");await expect(page.locator(".nt-task-list > li")).toHaveCount(1);expect(uncaught).toEqual([]);
  }finally{await appendFile(evidenceRoot + '/browser-storage.ndjson',JSON.stringify({at:new Date().toISOString(),engine:test.info().project.name,...scenario,uncaught})+"\n");}
 });
}


test("同tick双退出仅一个请求，旧logout迟响应不踢掉重新登录会话",async({page})=>{
 await fixture(page);const first=gate(),second=gate();let reads=0;
 await page.route("**/api/auth/logout",async route=>{reads++;if(reads===1)await first.promise;else await second.promise;await route.fulfill({contentType:"application/json",body:JSON.stringify({ok:true})});});
 await openMenu(page);const button=page.getByRole("button",{name:"退出登录",exact:true});await button.evaluate(element=>{(element as HTMLButtonElement).click();(element as HTMLButtonElement).click();});await expect.poll(()=>reads).toBeGreaterThanOrEqual(1);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const duplicateCount=reads;const wasDisabled=await button.isDisabled();
 first.release();await expect(page.getByRole("heading",{name:"登录面板",exact:true})).toBeVisible();await page.getByLabel("邮箱",{exact:true}).fill("new-session@example.invalid");await page.getByLabel("密码",{exact:true}).fill("synthetic password");await page.getByRole("button",{name:"登录",exact:true}).click();await expect(page.getByRole("heading",{name:"工作台",exact:true})).toBeVisible();
 if(duplicateCount>1){const response=page.waitForResponse(r=>r.url().endsWith("/api/auth/logout"));second.release();await(await response).finished();}else second.release();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await expect(page.getByRole("heading",{name:"工作台",exact:true})).toBeVisible();expect(duplicateCount).toBe(1);expect(wasDisabled).toBe(true);
});
test("同tick退出失败后解锁，允许再次退出且清空会话",async({page})=>{
 const pending=gate();const state=await fixture(page,{fail:{"POST /api/auth/logout":{status:503,error:"synthetic_logout_failure"}},hold:{"POST /api/auth/logout":pending.promise}});
 await openMenu(page);const button=page.getByRole("button",{name:"退出登录",exact:true});await button.evaluate(element=>{(element as HTMLButtonElement).click();(element as HTMLButtonElement).click();});await expect.poll(()=>state.counts["POST /api/auth/logout"]||0).toBeGreaterThanOrEqual(1);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const reads=state.counts["POST /api/auth/logout"];const disabled=await button.isDisabled();pending.release();await expect(page.locator(".toast[role=alert]")).toContainText("退出失败");await expect(button).toBeEnabled();expect(reads).toBe(1);expect(disabled).toBe(true);delete state.fail["POST /api/auth/logout"];await button.click();await expect(page.getByRole("heading",{name:"登录面板",exact:true})).toBeVisible();expect(state.counts["POST /api/auth/logout"]).toBe(2);
});


test("同种接入的公开实例名、指标和服务详情可以区分",async({page})=>{
 const base=integrationSnapshot().connections[0]!;
 await fixture(page,{integrations:integrationSnapshot({connections:[{...base,id:"east",name:"东区测速实例",serviceSlug:"synthetic-1",metrics:[{key:"scanned",label:"已扫描 IP",value:1500,unit:"个"}]},{...base,id:"west",name:"西区测速实例",serviceSlug:"synthetic-2",metrics:[{key:"scanned",label:"已扫描 IP",value:2600,unit:"个"}]}]})});await nav(page,"服务接入");
 const east=page.locator(".ni-connection").filter({has:page.getByRole("heading",{name:"东区测速实例",exact:true})});const west=page.locator(".ni-connection").filter({has:page.getByRole("heading",{name:"西区测速实例",exact:true})});await expect(east).toHaveCount(1);await expect(west).toHaveCount(1);await expect(east).toContainText("CFSpeed");await expect(west).toContainText("CFSpeed");await expect(east.locator(".ni-metrics")).toContainText("1,500");await expect(west.locator(".ni-metrics")).toContainText("2,600");await west.getByRole("button",{name:"查看 西区测速实例 服务详情",exact:true}).click();await expect(page.getByRole("dialog",{name:"Offline Service",exact:true})).toBeVisible();
});
test("60字符公开接入实例名在320px双主题和200%文字下不覆盖详情操作",async({page})=>{
 const name="SyntheticNode".repeat(4)+"EastNode";expect(name.length).toBe(60);const data=integrationSnapshot();data.connections[0]!.name=name;await fixture(page,{integrations:data});await nav(page,"服务接入");await page.setViewportSize({width:320,height:900});
 for(const theme of ["dark","light"]){await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);await noOverflow(page);const heading=page.getByRole("heading",{name,exact:true});await expect(heading).toBeVisible();const open=page.getByRole("button",{name:"查看 "+name+" 服务详情",exact:true});const bounds=await open.boundingBox();expect(bounds!.width).toBeGreaterThanOrEqual(44);expect(bounds!.height).toBeGreaterThanOrEqual(44);
 const overlap=await page.locator(".ni-connection header").evaluate(header=>{const range=document.createRange();range.selectNodeContents(header.querySelector("h3")!);const text=range.getBoundingClientRect();const button=header.querySelector("button")!.getBoundingClientRect();return Math.min(text.right,button.right)-Math.max(text.left,button.left)>.5&&Math.min(text.bottom,button.bottom)-Math.max(text.top,button.top)>.5;});expect(overlap).toBe(false);}
 await enlarged(page,".ni-integrations");await noOverflow(page);await capture(page,"integration-instance-long");
});

});

test("退出返回401表示会话已失效，应清理旧工作台返回登录",async({page})=>{
 const state=await fixture(page,{fail:{"POST /api/auth/logout":{status:401,error:"unauthorized"}}});
 state.authenticated=false;
 await openMenu(page);await page.getByRole("button",{name:"退出登录",exact:true}).click();
 await expect(page.getByRole("heading",{name:"登录面板",exact:true})).toBeVisible();
 await expect(page.locator(".app-shell")).toHaveCount(0);
 await expect(page.locator("article.nexus-service-card")).toHaveCount(0);
});
