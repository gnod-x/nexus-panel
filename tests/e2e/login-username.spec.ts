import { expect, test, type Page } from "@playwright/test";
async function fixture(page:Page,enabled:boolean,bootstrapped=true){
 await page.route("**/api/auth/status",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({bootstrapped,...(enabled?{usernameLoginEnabled:true}:{})})}));
 await page.route("**/api/auth/me",route=>route.fulfill({status:401,contentType:"application/json",body:JSON.stringify({error:"unauthorized"})}));
 await page.goto("/");
 await expect(page.getByRole("heading",{name:bootstrapped?"登录面板":"创建管理员",exact:true})).toBeVisible();
}
test("configured username mode accepts a short existing-account password and preserves username autocomplete",async({page})=>{
 let received:unknown;
 await page.route("**/api/auth/login",async route=>{
  received=route.request().postDataJSON();
  await route.fulfill({status:401,contentType:"application/json",body:JSON.stringify({error:"invalid_credentials"})});
 });
 await fixture(page,true);
 const account=page.getByLabel("账号",{exact:true});
 await expect(account).toHaveAttribute("type","text");
 await expect(account).toHaveAttribute("autocomplete","username");
 await account.fill("123456");
 await page.getByLabel("密码",{exact:true}).fill("123456");
 await page.getByRole("button",{name:"登录",exact:true}).click();
 await expect.poll(()=>received).toEqual({email:"123456",password:"123456"});
 await expect(page.locator(".nexus-auth-summary")).toBeVisible();
 await expect(account).toHaveValue("123456");
 await account.fill("synthetic@example.test");
 await page.getByRole("button",{name:"登录",exact:true}).click();
 await expect.poll(()=>received).toEqual({email:"synthetic@example.test",password:"123456"});
});
test("email-only mode and first-admin setup never adopt username validation",async({page})=>{
 let submissions=0;
 await page.route("**/api/auth/login",async route=>{submissions++;await route.fulfill({status:400,contentType:"application/json",body:'{"error":"invalid_input"}'});});
 await fixture(page,false);
 await expect(page.getByLabel("邮箱",{exact:true})).toHaveAttribute("type","email");
 await page.getByLabel("邮箱",{exact:true}).fill("123456");
 await page.getByLabel("密码",{exact:true}).fill("123456");
 await page.getByRole("button",{name:"登录",exact:true}).click();
 await expect(page.getByLabel("邮箱",{exact:true})).toHaveAttribute("aria-invalid","true");
 expect(submissions).toBe(0);
 await page.unroute("**/api/auth/status");
 await fixture(page,true,false);
 await expect(page.getByLabel("邮箱",{exact:true})).toHaveAttribute("type","email");
 await expect(page.getByLabel("账号",{exact:true})).toHaveCount(0);
});
