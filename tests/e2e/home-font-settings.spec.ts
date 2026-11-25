import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const stamp = "2026-11-22T00:00:00Z";

async function fixture(page: import("@playwright/test").Page, role: "admin" | "viewer" = "admin") {
  let savedFont = "calligraphy";
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(request.method() + " " + url);
    let payload: unknown;
    if (url === "/api/auth/status") payload = { bootstrapped: true };
    else if (url === "/api/auth/me") payload = { user: { id: 1, email: "font-fixture@example.test", role, createdAt: stamp } };
    else if (url === "/api/settings" && request.method() === "GET") payload = { homeFont: savedFont };
    else if (url === "/api/settings" && request.method() === "PATCH") {
      savedFont = request.postDataJSON().homeFont;
      payload = { homeFont: savedFont };
    } else if (url === "/api/groups") payload = { groups: [] };
    else if (url === "/api/services") payload = { services: [{
      id: 1, groupId: null, name: "合成服务", slug: "synthetic", description: "", url: "https://example.test",
      healthUrl: null, icon: null, tags: [], status: "unknown", latencyMs: null, lastCheckedAt: null,
      enabled: true, sortOrder: 0, createdAt: stamp, updatedAt: stamp,
    }] };
    else if (url === "/api/tasks") payload = { snapshot: { version: 1, mode: "unconfigured", observedAt: stamp, freshness: "unknown", tasks: [], sources: [] } };
    else if (url === "/api/integrations") payload = { snapshot: { version: 1, mode: "unconfigured", observedAt: stamp, connections: [], available: [] } };
    else payload = { events: [] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/#/manage/settings");
  return { writes, selectedFont: () => savedFont };
}

test("管理员可预览并保存首页字体，设置持久应用且仅作用于首页", async ({ page }) => {
  const { writes, selectedFont } = await fixture(page);
  const choice = page.getByRole("combobox", { name: "首页字体" });
  await expect(choice).toBeVisible();
  await expect(choice.locator("option")).toHaveText(["柳体", "黑体", "宋体", "楷体"]);
  const artifactRoot = process.env.E2E_ARTIFACT_ROOT || "artifacts/home-font-settings";
  await mkdir(artifactRoot, { recursive: true });
  await page.screenshot({ path: artifactRoot + "/settings-desktop.png", fullPage: true });
  await choice.selectOption("sans");
  await expect(page.locator(".home-font-preview")).toHaveCSS("font-family", /PingFang SC/);
  await page.getByRole("button", { name: "保存字体" }).click();
  await expect(page.getByRole("status").filter({ hasText: "首页字体已保存" })).toBeVisible();
  expect(selectedFont()).toBe("sans");
  expect(writes).toEqual(["PATCH /api/settings"]);

  await page.getByRole("main").getByRole("button", { name: "返回首页" }).click();
  await expect(page.locator(".nexus-home")).toHaveAttribute("data-home-font", "sans");
  await expect(page.locator(".nx-tile-name").first()).toHaveCSS("font-family", /PingFang SC/);
  await page.screenshot({ path: artifactRoot + "/homepage-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator(".nexus-home")).toHaveJSProperty("dataset.homeFont", "sans");
  await page.screenshot({ path: artifactRoot + "/homepage-mobile.png", fullPage: true });
  expect(await page.locator(".nexus-home").evaluate((element) => element.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto("/#/manage/settings");
  await expect(choice).toHaveValue("sans");
});

test("viewer sees the current font but cannot change the global choice", async ({ page }) => {
  const { writes } = await fixture(page, "viewer");
  await expect(page.getByText("柳体", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "首页字体" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存字体" })).toHaveCount(0);
  expect(writes).toEqual([]);
});
