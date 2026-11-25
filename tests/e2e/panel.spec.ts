import { expect, test, type Page } from "@playwright/test";

async function enterManagement(page:Page){
 if(!await page.locator(".admin-shell").count())await page.getByRole("button",{name:"进入管理",exact:true}).click();
}
async function openMenu(page:Page){
 await enterManagement(page);
 if(await page.getByRole("button",{name:/^打开导航(?:菜单)?$/}).isVisible() && await page.locator(".sidebar").getAttribute("role")!=="dialog")await page.getByRole("button",{name:/^打开导航(?:菜单)?$/}).click();
}
async function nav(page:Page,name:string|RegExp){
 if(name==="工作台"){if(!await page.locator(".website-shell").count()){await openMenu(page);await page.locator(".sidebar nav").getByRole("button",{name:"返回首页",exact:true}).click();}return;}
 if(name==="任务中心"){await openMenu(page);await page.locator(".sidebar nav").getByRole("button",{name:"任务中心",exact:true}).click();return;}
 await openMenu(page);
 const target=name==="全部服务"?"服务管理":name==="添加分组"?"分组管理":name;
 await page.locator(".sidebar nav").getByRole("button",{name:typeof target==="string"&&["服务管理","收藏服务"].includes(target)?new RegExp("^"+target+"(?:\\s*(?:\\d+|—))?$"):target,exact:typeof target==="string"}).click();
 if(name==="添加分组")await page.getByRole("button",{name:"新建分组",exact:true}).click();
}

test("管理员可以初始化面板、管理服务分组并导入数据", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "创建管理员" })).toBeVisible();

  await page.getByLabel("邮箱", { exact: true }).fill("admin@example.test");
  await page.getByLabel("密码", { exact: true }).fill("correct horse battery staple");
  await page.getByRole("button", { name: "创建管理员" }).click();
  await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
  const logoutResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/logout"),
  );
  await openMenu(page);
  await page.getByRole("button", { name: "退出登录" }).click();
  expect((await logoutResponse).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "登录面板" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "登录面板" })).toBeVisible();
  await page.getByLabel("邮箱", { exact: true }).fill("admin@example.test");
  await page.getByLabel("密码", { exact: true }).fill("correct horse battery staple");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();

  await enterManagement(page);
  await page.getByRole("button", { name: "添加服务" }).click();
  await expect(page.getByRole("heading", { name: "添加服务" })).toBeVisible();
  await page.getByLabel("名称").fill("Cloudflare DNS");
  await page.getByLabel("标识符").fill("cloudflare-dns");
  await page.getByLabel("访问地址").fill("https://1.1.1.1");
  await page.getByLabel("描述").fill("公共 DNS 服务");
  await page.getByRole("button", { name: "保存服务" }).click();
  await expect(page.getByText("Cloudflare DNS", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "打开服务" }))
    .toHaveAttribute("href", "https://1.1.1.1");
  await expect(page.getByRole("link", { name: "打开服务" }))
    .toHaveAttribute("rel", "noopener noreferrer");
  await page.getByRole("button", { name: "关闭服务详情" }).click();
  await expect(page.locator(".service-row")).toHaveCount(1);
  await page.getByRole("button", { name: "搜索服务", exact: true }).click();
  const search = page.getByLabel("服务搜索关键词");
  await expect(search).toBeFocused();
  await search.fill("Cloudflare");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "搜索服务" })).toHaveCount(0);

  await nav(page, "分组管理");
  await page.getByRole("button", { name: "新建分组" }).click();
  await page.getByLabel("分组名称").fill("Infrastructure");
  await page.getByLabel("分组标识符").fill("infrastructure");
  await page.getByRole("button", { name: "保存分组" }).click();
  await openMenu(page);
  await expect(page.locator(".sidebar nav").getByRole("button", { name: /Infrastructure/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "编辑分组Infrastructure", exact: true }).click();
  await page.getByLabel("分组名称").fill("Core Services");
  await page.getByLabel("分组标识符").fill("core-services");
  await page.getByRole("button", { name: "保存分组" }).click();
  await openMenu(page);
  await expect(page.locator(".sidebar nav").getByRole("button", { name: /Core Services/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await nav(page, "导入数据");
  await page.getByLabel("导入文件").setInputFiles({
    name: "sun-panel-export.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      groups: [{ name: "Imported Group", slug: "imported-group" }],
      services: [{
        groupSlug: "imported-group",
        name: "Synthetic Status",
        slug: "synthetic-status",
        url: "https://1.1.1.1",
      }],
    })),
  });
  await expect(page.getByRole("dialog", { name: "导入 Sun-Panel" }).getByRole("status"))
    .toContainText("1 个分组、1 个服务");
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.locator(".toast.success")).toContainText("已导入 1 个分组、1 个服务");
  await openMenu(page);
  await expect(page.locator(".sidebar nav").getByRole("button", { name: /Imported Group/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "编辑分组Core Services", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除分组" }).click();
  await openMenu(page);
  await expect(page.locator(".sidebar nav").getByRole("button", { name: /Core Services/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await nav(page, "全部服务");
  await page.locator("#global-search").fill("Cloudflare");
  await expect(page.locator(".service-row")).toHaveCount(1);
  await page.getByRole("combobox", { name: "状态筛选" }).selectOption("unknown");
  await expect(page.locator(".status-pill", { hasText: "未检查" })).toBeVisible();

  await page.locator(".service-row").click();
  await page.locator(".drawer").getByRole("button", { name: "收藏服务" }).click();
  await page.getByRole("button", { name: "关闭服务详情" }).click();
  await nav(page, /收藏服务\s*1/);
  await expect(page.locator(".page-head h1")).toHaveText("收藏服务");
  await expect(page.getByText("Cloudflare DNS", { exact: true }).first()).toBeVisible();

  if (process.env.CAPTURE_SCREENSHOTS === "1") {
    await page.screenshot({ path: "test-results/nexus-panel-desktop.png", fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^打开导航(?:菜单)?$/ }).click();
  await expect(page.getByRole("button", { name: "设置" })).toBeVisible();
  await page.getByRole("button", { name: "关闭导航" }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);

  if (process.env.CAPTURE_SCREENSHOTS === "1") {
    await page.screenshot({ path: "test-results/nexus-panel-mobile.png", fullPage: true });
  }
});
