const evidenceRoot = process.env.E2E_ARTIFACT_ROOT || "artifacts/home-refresh";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Task, TaskSnapshot } from "../../src/shared/tasks";

const observedAt = "2026-11-21T06:00:00.000Z";
const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id, sourceId: "application", name: "Synthetic " + id, serviceName: "Archive",
  kind: "calendar", schedule: "daily", timezone: "Asia/Shanghai", enabled: true,
  state: "unknown", lastStartedAt: null, lastFinishedAt: null, durationMs: null,
  exitCode: null, nextRunAt: null, nextRunKind: "unknown",
  sourceUpdatedAt: observedAt, observedAt, freshness: "fresh", ...overrides,
});
const snapshot: TaskSnapshot = {
  version: 1, mode: "demo", observedAt, freshness: "fresh",
  sources: [
    { id: "application", name: "Synthetic application", kind: "application", status: "ok", completeness: "partial", observedAt, freshness: "fresh" },
    { id: "systemd", name: "Synthetic systemd", kind: "systemd", status: "permission_denied", completeness: "unknown", observedAt, freshness: "unknown", error: "permission_denied" },
    { id: "cron", name: "Synthetic cron", kind: "cron", status: "unavailable", completeness: "unknown", observedAt: null, freshness: "unknown", error: "not_configured" },
  ],
  tasks: [
    makeTask("later", { name: "Later calendar", nextRunAt: "2026-11-22T08:00:00Z", nextRunKind: "authoritative", state: "succeeded", durationMs: 1400, exitCode: 0, lastStartedAt: observedAt, lastFinishedAt: "2026-11-21T06:00:01.400Z" }),
    makeTask("manual", { name: "Manual review", kind: "manual", schedule: null, serviceName: "Media", enabled: null, freshness: "stale" }),
    makeTask("estimated", { name: "Estimated archive", nextRunAt: "2026-11-22T07:00:00Z", nextRunKind: "estimated", state: "failed", exitCode: 2, durationMs: 65000 }),
    makeTask("confirmed", { name: "Confirmed archive", nextRunAt: "2026-11-22T07:00:00Z", nextRunKind: "authoritative", state: "running" }),
    makeTask("disabled", { name: "Disabled calendar", nextRunAt: "2026-11-21T07:00:00Z", nextRunKind: "authoritative", enabled: false }),
  ],
};

async function openTasks(page: Page, data = snapshot, failure?: { failed: boolean; delayed?: Promise<void> }) {
  const methods: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/tasks")) {
      methods.push(route.request().method());
      if (failure?.delayed) await failure.delayed;
      if (failure?.failed) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "task_snapshot_unavailable" }) });
        return;
      }
    }
    const payload = path === "/api/auth/status" ? { bootstrapped: true }
      : path === "/api/auth/me" ? { user: { id: 1, email: "tasks-fixture@example.test", role: "viewer", createdAt: observedAt } }
      : path === "/api/services" ? { services: [] }
      : path === "/api/groups" ? { groups: [] }
      : path === "/api/events" ? { events: [] }
      : path === "/api/tasks" ? { snapshot: data }
      : { error: "unexpected_test_request" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "进入管理", exact: true }).click();
  await page.locator(".sidebar").getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "任务中心", exact: true })).toBeVisible();
  return methods;
}
const rows = (page: Page) => page.locator(".nt-task-list > li");
const row = (page: Page, name: string) => rows(page).filter({ has: page.getByRole("heading", { name, exact: true }) });
async function noOverflow(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const width = await page.evaluate(() => ({ inner: innerWidth, scroll: document.documentElement.scrollWidth }));
  const offenders = await page.locator("body *").evaluateAll(elements => elements.filter(element => {
    const box = element.getBoundingClientRect(); return box.width > 0 && box.right > innerWidth + .5 && getComputedStyle(element).visibility !== "hidden";
  }).map(element => ({ tag: element.tagName, class: element.className, text: element.textContent?.trim().slice(0, 80), right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width, parent: element.parentElement?.className })));
  const overflowContent = width.scroll > width.inner ? await page.locator("body *").evaluateAll(elements => elements.flatMap(element => {
    const box = element.getBoundingClientRect();
    if (!box.width) return [];
    const range = document.createRange();
    range.selectNodeContents(element);
    const textRight = Math.max(...Array.from(range.getClientRects()).map(rect => rect.right));
    if (element.scrollWidth <= element.clientWidth + 1 && box.right <= innerWidth + .5 && textRight <= innerWidth + .5) return [];
    const style = getComputedStyle(element);
    return [{ tag: element.tagName, class: element.className, text: element.textContent?.trim().slice(0, 65), right: box.right, width: box.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, textRight, visibility: style.visibility, overflow: style.overflow, whiteSpace: style.whiteSpace, position: style.position, parent: element.parentElement?.className }];
  })) : [];
  expect(width.scroll, JSON.stringify({ offenders, overflowContent })).toBeLessThanOrEqual(width.inner);
}

test("只读任务按下次时间排序并区分估算、未知、停用和来源覆盖", async ({ page }) => {
  const methods = await openTasks(page);
  await expect(rows(page)).toHaveCount(5);
  await expect(page.locator(".nt-mode")).toContainText("演示数据");
  await expect(page.locator(".nt-mode")).toContainText("不会执行任何任务");
  await expect(page.locator(".nt-sources")).toContainText("权限不足");
  await expect(page.locator(".nt-sources")).toContainText("覆盖范围未知");
  await expect(page.locator(".nt-sources")).toContainText("尚未配置此来源");
  await expect(rows(page).locator("h3")).toHaveText(["Confirmed archive", "Estimated archive", "Later calendar", "Disabled calendar", "Manual review"]);
  await expect(row(page, "Estimated archive")).toContainText("估算时间，并非调度器确认");
  await expect(row(page, "Manual review")).toContainText("状态未知");
  await expect(row(page, "Manual review")).toContainText("手动触发，无固定时间");
  await expect(row(page, "Manual review")).not.toContainText("上次成功");
  await expect(row(page, "Disabled calendar").locator(".nt-row-facts").first()).toContainText("已停用");
  await expect(row(page, "Confirmed archive")).toContainText("Asia/Shanghai");
  await expect(page.locator(".nexus-tasks").getByRole("button", { name: /执行任务|运行任务|删除|重启|编辑/ })).toHaveCount(0);
  await page.locator(".nexus-tasks .nt-header > button").click();
  await expect.poll(() => methods.length).toBeGreaterThanOrEqual(2);
  expect(methods.every((method) => method === "GET")).toBe(true);
});

test("任务关键词、服务、来源、状态和排序筛选可组合及重置", async ({ page }) => {
  await openTasks(page);
  await expect(rows(page)).toHaveCount(5);
  await page.getByLabel("搜索任务", { exact: true }).fill("archive");
  await expect(rows(page)).toHaveCount(4);
  await page.getByLabel("按服务筛选任务").selectOption("Archive");
  await page.getByLabel("按来源筛选任务").selectOption("application");
  await page.getByLabel("按状态筛选任务").selectOption("failed");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("Estimated archive");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.getByLabel("任务排序").selectOption("last");
  await expect(rows(page).first()).toContainText("Later calendar");
  await page.getByLabel("按来源筛选任务").selectOption("systemd");
  await expect(page.getByText("没有匹配的任务", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重置任务筛选" }).click();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByLabel("搜索任务", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("按来源筛选任务")).toHaveValue("all");
});

test("任务详情支持键盘、明确未知退出码和时间依据并恢复焦点", async ({ page }) => {
  await openTasks(page);
  const opener = page.getByRole("button", { name: "查看任务 Manual review 详情", exact: true });
  await opener.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByRole("dialog", { name: "任务详情：Manual review", exact: true });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("未知；不能据此判断成功");
  await expect(detail).toContainText("证据已过期");
  await expect(detail).toContainText("不根据历史记录推断下次执行");
  await expect(detail).toContainText("演示数据 · 不对应家庭服务");
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.getByRole("button", { name: "查看任务 Later calendar 详情", exact: true }).click();
  const completed = page.getByRole("dialog", { name: "任务详情：Later calendar", exact: true });
  await expect(completed).toContainText("1.4 秒");
  await expect(completed).toContainText("Asia/Shanghai");
  await expect(completed.locator(".nt-detail-facts > div").filter({ has: page.locator("dt").getByText("退出码", { exact: true }) }).locator("dd")).toHaveText("0");
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await expect(completed).toHaveCount(0);
});

test("未接入空态不声称没有任务，错误可重试且加载状态可见", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const state = { failed: true, delayed };
  await openTasks(page, { ...snapshot, mode: "unconfigured", tasks: [] }, state);
  await expect(page.locator(".nexus-tasks")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator(".nexus-tasks .nt-header > button")).toBeDisabled();
  release();
  await expect(page.getByRole("alert")).toContainText("任务读取失败");
  state.failed = false;
  await page.getByRole("button", { name: "重试读取任务" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("尚未接入任务来源", { exact: true })).toBeVisible();
  await expect(page.getByText("还没有可展示的任务", { exact: true })).toBeVisible();
  await expect(page.locator(".nt-empty")).toContainText("没有记录不等于所有任务已停止");
});

test("任务页双主题、移动布局、200%文字与减少动态均可用", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openTasks(page, { ...snapshot, tasks: [makeTask("long", { name: "很长的合成服务任务名称用于验证窄屏布局不会溢出或遮挡详情入口", schedule: "0 30 12 * * MON-FRI", serviceName: "AnExtremelyLongSyntheticServiceNameWithoutSpacesForOverflowVerification" })] });
  await expect(rows(page)).toHaveCount(1);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await noOverflow(page);
      const opener = rows(page).getByRole("button", { name: /^查看任务/ });
      await opener.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await noOverflow(page);
      await page.keyboard.press("Escape");
    }
  }
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.locator("html").evaluate((root) => { (root as HTMLElement).style.fontSize = "28px"; });
  await noOverflow(page);
  await rows(page).getByRole("button", { name: /^查看任务/ }).click();
  await noOverflow(page);
  await page.keyboard.press("Escape");
  const small = await page.locator(".nexus-tasks button, .nexus-tasks input, .nexus-tasks select").evaluateAll((elements) => elements.filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && (box.width < 43.5 || box.height < 43.5); }).map((element) => element.getAttribute("aria-label") || element.textContent));
  expect(small).toEqual([]);
});


test("保留云端任务中心视觉记录", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openTasks(page);
  await expect(rows(page)).toHaveCount(5);
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({ path: evidenceRoot + '/tasks-light.png', fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: evidenceRoot + '/tasks-dark.png', fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: evidenceRoot + '/tasks-mobile.png', fullPage: true, animations: "disabled" });
});
