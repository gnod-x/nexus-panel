import { expect, test } from "@playwright/test";

test("代理来源不匹配时创建管理员提示配置错误，而非密码错误", async ({ page }) => {
  await page.route("**/api/auth/status", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ bootstrapped: false }),
  }));
  await page.route("**/api/auth/bootstrap", (route) => route.fulfill({
    status: 403, contentType: "application/json", body: JSON.stringify({ error: "origin_forbidden" }),
  }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "创建管理员", exact: true })).toBeVisible();
  await page.getByLabel("邮箱", { exact: true }).fill("synthetic-origin@example.test");
  await page.getByLabel("密码", { exact: true }).fill("disposable synthetic test password");
  await page.getByRole("button", { name: "创建管理员", exact: true }).click();
  const error = page.locator(".nexus-auth-summary");
  await expect(error).toContainText(/PUBLIC_ORIGIN|公网|代理|来源/);
  await expect(error).not.toContainText("邮箱或密码不正确");
});
