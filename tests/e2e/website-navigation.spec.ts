import {mkdir} from "node:fs/promises";
import {expect,test,type Page} from "@playwright/test";
const stamp="2026-11-22T00:00:00Z";
async function fixture(page:Page,role="admin",path="/"){
 const writes:string[]=[];
 await page.route("**/api/**",async route=>{
  const request=route.request(),url=new URL(request.url()).pathname;
  if(request.method()!=="GET")writes.push(request.method()+" "+url);
  const payload=url==="/api/auth/status"?{bootstrapped:true}:url==="/api/auth/me"?{user:{id:1,email:"website-fixture@example.test",role,createdAt:stamp}}:url==="/api/groups"?{groups:[{id:1,name:"合成分组",slug:"synthetic",color:"#358166",sortOrder:0,createdAt:stamp}]}:url==="/api/services"?{services:[{id:1,groupId:1,name:"合成服务",slug:"synthetic",description:"网站前后台隔离验收",url:"https://example.test",healthUrl:null,icon:null,tags:[],status:"unknown",latencyMs:null,lastCheckedAt:null,enabled:true,sortOrder:0,createdAt:stamp,updatedAt:stamp}]}:url==="/api/tasks"?{snapshot:{version:1,mode:"unconfigured",observedAt:stamp,freshness:"unknown",tasks:[],sources:[]}}:url==="/api/integrations"?{snapshot:{version:1,mode:"unconfigured",observedAt:stamp,connections:[],available:[]}}:{events:[]};
  await route.fulfill({contentType:"application/json",body:JSON.stringify(payload)});
 });
 await page.goto(path);return writes;
}
test("网站首页独立且详情只读，显式管理后才出现写操作",async({page})=>{
 const writes=await fixture(page);
 await expect(page.getByRole("heading",{name:"工作台",exact:true})).toBeVisible();
 await expect(page.locator(".sidebar")).toHaveCount(0);
 await expect(page.locator(".nx-more, .nx-service-status")).toHaveCount(0);
 await mkdir(process.env.E2E_ARTIFACT_ROOT || "artifacts/website-front",{recursive:true});
 await page.screenshot({path:(process.env.E2E_ARTIFACT_ROOT || "artifacts/website-front")+"/website-home-desktop.png",fullPage:true});
 await page.setViewportSize({width:375,height:900});await page.screenshot({path:(process.env.E2E_ARTIFACT_ROOT || "artifacts/website-front")+"/website-home-mobile.png",fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await expect(page.getByRole("button",{name:/^(添加服务|新建分组|立即检查)$/})).toHaveCount(0);
 await page.locator(".nexus-card-details").click();
 const detail=page.getByRole("dialog",{name:"合成服务",exact:true});
 await expect(detail.getByRole("button",{name:/^(编辑|删除|立即检查)$/})).toHaveCount(0);
 await detail.getByRole("button",{name:"管理此服务",exact:true}).click();
 await expect(page).toHaveURL(/#\/manage\/services/);
 await expect(page.getByRole("button",{name:"编辑",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"立即检查",exact:true})).toBeVisible();
 expect(writes).toEqual([]);
});
test("管理hash深链及浏览器前进后退保留网站与后台边界",async({page})=>{
 await fixture(page,"admin","/#/manage/services");
 await expect(page.locator(".sidebar")).toBeVisible();
 await expect(page.getByRole("heading",{name:"工作台",exact:true})).toHaveCount(0);
 await page.locator(".sidebar nav").getByRole("button",{name:"分组管理",exact:true}).click();
 await expect(page).toHaveURL(/#\/manage\/groups$/);
 await expect(page.getByRole("button",{name:"新建分组",exact:true})).toBeVisible();
 await page.goBack();await expect(page).toHaveURL(/#\/manage\/services$/);
 await page.goForward();await expect(page).toHaveURL(/#\/manage\/groups$/);
 await page.locator(".sidebar").getByRole("button",{name:"返回首页",exact:true}).click();
 await expect(page.getByRole("heading",{name:"工作台",exact:true})).toBeVisible();
 await expect(page.locator(".sidebar")).toHaveCount(0);
 await page.goBack();await expect(page).toHaveURL(/#\/manage\/groups$/);
});
test("viewer首页和管理深链都不显示管理写操作",async({page})=>{
 const writes=await fixture(page,"viewer");
 await page.locator(".nexus-card-details").click();
 await expect(page.getByRole("dialog").getByRole("button",{name:/^(编辑|删除|立即检查|管理此服务)$/})).toHaveCount(0);
 await page.keyboard.press("Escape");
 await page.goto("/#/manage/services");
 await expect(page.locator(".sidebar")).toBeVisible();
 await expect(page.getByRole("button",{name:/^(添加服务|新建分组|导入数据)$/})).toHaveCount(0);
 await page.locator(".service-row").first().click();
 await expect(page.getByRole("dialog").getByRole("button",{name:/^(编辑|删除|立即检查)$/})).toHaveCount(0);
 expect(writes).toEqual([]);
});

test("离开后台清除编辑及导入dialog，前进不复活",async({page})=>{
 await fixture(page);
 await page.getByRole("button",{name:"进入管理",exact:true}).click();
 await page.locator(".service-row").first().click();await page.getByRole("button",{name:"编辑",exact:true}).click();
 await expect(page.getByRole("dialog",{name:"编辑服务",exact:true})).toBeVisible();
 await page.goBack();await expect(page.locator(".website-shell")).toBeVisible();await expect(page.getByRole("dialog")).toHaveCount(0);
 await page.goForward();await expect(page.locator(".admin-shell")).toBeVisible();await expect(page.getByRole("dialog")).toHaveCount(0);
 await page.locator(".sidebar nav").getByRole("button",{name:"导入数据",exact:true}).click();
 await expect(page.getByRole("dialog",{name:"导入 Sun-Panel",exact:true})).toBeVisible();
 await page.goBack();await expect(page.locator(".website-shell")).toBeVisible();await expect(page.getByRole("dialog")).toHaveCount(0);
 await page.goForward();await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("手机后台drawer返回首页后聚焦新页面标题",async({page})=>{
 await page.setViewportSize({width:375,height:900});await fixture(page);
 await page.getByRole("button",{name:"进入管理",exact:true}).click();
 await page.getByRole("button",{name:"打开导航",exact:true}).click();
 await page.getByRole("dialog",{name:"导航",exact:true}).getByRole("button",{name:"返回首页",exact:true}).click();
 await expect(page.getByRole("heading",{name:"工作台",exact:true})).toBeFocused();await expect(page.locator(".sidebar")).toHaveCount(0);
});
