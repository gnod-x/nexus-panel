const evidenceRoot = process.env.E2E_ARTIFACT_ROOT || "artifacts/home-refresh";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { IntegrationConnection, IntegrationSnapshot } from "../../src/shared/integrations";
const timestamp = "2026-11-20T10:00:00.000Z";
function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return { id: "cfspeed", name: "CFSpeed", kind: "cfspeed", status: "connected", serviceSlug: null, observedAt: timestamp, checkedAt: timestamp, sourceUpdatedAt: null, freshness: "fresh", metrics: [{ key: "scanned", label: "已扫描 IP", value: 1280, unit: "个" }], errorCode: null, ...overrides };
}
function snapshot(mode: IntegrationSnapshot["mode"], connections: IntegrationConnection[]): IntegrationSnapshot {
  return { version: 1, mode, observedAt: timestamp, connections, available: [{ kind: "cfspeed", name: "CFSpeed", summary: "只读汇总", authentication: "none" }, { kind: "quark-vod", name: "Quark-VOD", summary: "只读汇总", authentication: "bearer-file" }] };
}
async function open(page: Page, data: IntegrationSnapshot, apiFailure = false) {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const payload = path === "/api/auth/status" ? { bootstrapped: true }
      : path === "/api/auth/me" ? { user: { id: 1, email: "synthetic@example.test", role: "admin", createdAt: timestamp } }
      : path === "/api/services" ? { services: [] }
      : path === "/api/groups" ? { groups: [] }
      : path === "/api/events" ? { events: [] }
      : path === "/api/integrations" ? apiFailure ? { error: "http://private.example.test/?token=SYNTHETIC_SECRET /secrets/synthetic-token-file RAW_UPSTREAM_BODY" } : { snapshot: data }
      : path === "/api/tasks" ? { snapshot: { version: 1, mode: "unconfigured", observedAt: timestamp, freshness: "unknown", tasks: [], sources: [] } }
      : {};
    await route.fulfill({ status: path === "/api/integrations" && apiFailure ? 502 : 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "进入管理", exact:true }).click();
  await page.locator(".sidebar").getByRole("button", { name: "服务接入", exact: true }).click();
  await expect(page.getByRole("heading", { name: "服务接入", exact: true })).toBeVisible();
}
async function safeDom(page: Page) {
  const html = await page.locator("body").innerHTML();
  for (const secret of ["private.example.test", "SYNTHETIC_SECRET", "synthetic-token-file", "RAW_UPSTREAM_BODY"]) expect(html).not.toContain(secret);
  await expect(page.locator(".ni-integrations input")).toHaveCount(0);
}

test("演示指标持续标注，不能冒充家庭服务状态", async ({ page }) => {
  await open(page, snapshot("demo", [connection({ status: "demo" })]));
  await expect(page.getByText("演示模式 · 非家庭实时状态", { exact: true })).toBeVisible();
  await expect(page.getByText("示例指标 · 非家庭实时数据", { exact: true })).toBeVisible();
  await expect(page.locator(".ni-state")).toHaveText("演示数据");
  await expect(page.locator(".ni-metrics dd")).toContainText("1,280");
  await safeDom(page);
});

test("真实接入展示白名单指标，并区分检查与上游时间", async ({ page }) => {
  await open(page, snapshot("live", [connection(), connection({ id: "quark-vod", kind: "quark-vod", name: "Quark-VOD", metrics: [{ key: "saved", label: "已保存", value: 42, unit: "项" }] })]));
  await expect(page.getByText("真实接入 · 只读指标", { exact: true })).toBeVisible();
  await expect(page.locator(".ni-connection")).toHaveCount(2);
  await expect(page.locator(".ni-state").first()).toHaveText("已连接");
  await expect(page.getByText("最近成功读取的指标", { exact: true })).toHaveCount(2);
  await expect(page.getByText("上游更新", { exact: false })).toHaveCount(0);
  await safeDom(page);
});

test("未配置时支持适配器不等于已接入，不显示虚构零指标", async ({ page }) => {
  await open(page, snapshot("unconfigured", [connection({ status: "unconfigured", metrics: [], observedAt: null, checkedAt: null, freshness: "unknown" })]));
  await expect(page.getByText("尚未配置真实接入", { exact: true })).toBeVisible();
  await expect(page.locator(".ni-state")).toHaveText("未配置");
  await expect(page.locator(".ni-metrics")).toHaveCount(0);
  const catalog = page.locator(".ni-catalog");
  await expect(catalog).not.toHaveAttribute("open");
  await catalog.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(catalog.getByText("这里说明已支持的能力，不代表已经连接或通过验证。", { exact: true })).toBeVisible();
  await expect(catalog.getByRole("heading", { name: "Quark-VOD", exact: true })).toBeVisible();
});

for (const [code, expected] of [["permission_denied", "上游拒绝访问，请由管理员检查读取权限。"], ["unsupported_data", "上游返回的格式暂不支持，未读取新指标。"], ["unavailable", "上游服务暂时无法访问。"]] as const) {
  test(`读取失败反馈 ${code}`, async ({ page }) => {
    await open(page, snapshot("live", [connection({ status: "error", metrics: [], errorCode: code })]));
    await expect(page.getByText(expected, { exact: true })).toBeVisible();
    await expect(page.getByText("暂无有效指标，等待成功读取。", { exact: true })).toBeVisible();
    await expect(page.locator(".ni-metrics")).toHaveCount(0);
  });
}

test("失败后保留的最后有效指标标明过期", async ({ page }) => {
  await open(page, snapshot("live", [connection({ status: "error", freshness: "stale", errorCode: "timeout" })]));
  await expect(page.getByText("上次有效指标 · 已过期，不能代表当前状态", { exact: true })).toBeVisible();
  await expect(page.getByText("上游响应超时，请稍后重试。", { exact: true })).toBeVisible();
  await expect(page.locator(".ni-metrics dd")).toContainText("1,280");
  await expect(page.getByText("最近成功读取的指标", { exact: true })).toHaveCount(0);
});

test("接口错误不输出凭据、私有地址、路径或上游正文", async ({ page }) => {
  await open(page, snapshot("unconfigured", []), true);
  await expect(page.getByText("无法读取服务接入信息", { exact: true })).toBeVisible();
  await safeDom(page);
  await expect(page.getByRole("button", { name: "重新读取", exact: true })).toBeVisible();
});

for (const theme of ["dark", "light"]) {
  test(`320px ${theme} 支持键盘和触控，不横向溢出`, async ({ page }) => {
    await open(page, snapshot("demo", [connection({ status: "demo" })]));
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    await page.setViewportSize({ width: 320, height: 780 });
    const refresh = page.getByRole("button", { name: "刷新接入", exact: true });
    await refresh.focus();
    await expect(refresh).toBeFocused();
    const box = await refresh.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    const metrics = await page.locator(".ni-integrations").evaluate(element => ({ right: element.getBoundingClientRect().right, width: window.innerWidth, fonts: [...element.querySelectorAll("*")].filter(item => item.textContent?.trim()).map(item => parseFloat(getComputedStyle(item).fontSize)) }));
    expect(metrics.right).toBeLessThanOrEqual(metrics.width);
    expect(Math.min(...metrics.fonts)).toBeGreaterThanOrEqual(12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
}


async function geometry(page: Page) {
  const result = await page.locator(".ni-integrations").evaluate(root => {
    const buttons = [...root.querySelectorAll("button, summary")].map(element => ({ element, box: element.getBoundingClientRect() })).filter(item => item.box.width > 0 && item.box.height > 0);
    const small = buttons.filter(({ box }) => box.width < 43.5 || box.height < 43.5).map(({ element, box }) => ({ name: element.getAttribute("aria-label") || element.textContent, width: box.width, height: box.height }));
    const overlaps: string[] = [];
    buttons.forEach((a, index) => buttons.slice(index + 1).forEach(b => {
      if (Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > .5 && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > .5) overlaps.push(a.element.textContent + " / " + b.element.textContent);
    }));
    return { small, overlaps, width: document.documentElement.scrollWidth, viewport: innerWidth };
  });
  expect(result.small).toEqual([]);
  expect(result.overlaps).toEqual([]);
  expect(result.width).toBeLessThanOrEqual(result.viewport);
}

test("接入页所有操作在320至桌面尺寸有独立44px区域，放大文字不溢出", async ({ page }) => {
  await open(page, snapshot("live", [connection({ serviceSlug: "synthetic-cfspeed" }), connection({ id: "quark-vod", kind: "quark-vod", name: "Quark-VOD", status: "error", freshness: "stale", errorCode: "permission_denied", serviceSlug: "synthetic-quark", metrics: [{ key: "saved", label: "已保存", value: 42, unit: "项" }] })]));
  for (const theme of ["dark", "light"]) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await geometry(page);
    }
  }
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.locator(".ni-catalog > summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".ni-catalog")).toHaveAttribute("open", "");
  await page.locator(".ni-integrations").evaluate(root => {
    const entries = [...root.querySelectorAll("*")].map(element => ({ element: element as HTMLElement, size: parseFloat(getComputedStyle(element).fontSize) }));
    entries.forEach(({ element, size }) => { element.style.fontSize = size * 2 + "px"; });
  });
  await geometry(page);
});

test("保存云端接入页真实浏览器视觉记录", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, snapshot("demo", [connection({ status: "demo" }), connection({ id: "quark-vod", kind: "quark-vod", name: "Quark-VOD", status: "demo", metrics: [{ key: "saved", label: "已保存", value: 42, unit: "项" }, { key: "pending", label: "待处理", value: 5, unit: "项" }] })]));
  await mkdir(evidenceRoot, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path: evidenceRoot + '/integrations-dark.png', fullPage: true, animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.screenshot({ path: evidenceRoot + '/integrations-light.png', fullPage: true, animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({ path: evidenceRoot + '/integrations-mobile.png', fullPage: true, animations: "disabled" });
});
