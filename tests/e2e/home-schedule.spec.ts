const evidenceRoot = process.env.E2E_ARTIFACT_ROOT || "artifacts/home-refresh";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Task, TaskSnapshot } from "../../src/shared/tasks";

const stamp = new Date().toISOString();
const after = (minutes: number) => new Date(Date.parse(stamp) + minutes * 60_000).toISOString();
const before = (minutes: number) => new Date(Date.parse(stamp) - minutes * 60_000).toISOString();
const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id, sourceId: "source", name: id, serviceName: "合成归档服务", kind: "calendar",
  schedule: "daily", timezone: "Asia/Shanghai", enabled: true, state: "unknown",
  lastStartedAt: null, lastFinishedAt: null, durationMs: null, exitCode: null,
  nextRunAt: null, nextRunKind: "unknown", sourceUpdatedAt: null, observedAt: stamp,
  freshness: "fresh", ...overrides,
});
const snapshot = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  version: 1, mode: "live", observedAt: stamp, freshness: "fresh",
  sources: [{ id: "source", name: "合成调度来源", kind: "systemd", status: "ok",
    completeness: "partial", observedAt: stamp, freshness: "fresh" }],
  tasks: [task("资料归档", { nextRunAt: after(30), nextRunKind: "authoritative" })],
  ...overrides,
});
type FixtureState = { data: TaskSnapshot; serviceCount: number; failure: boolean; hold?: Promise<void>; methods: string[] };
const tasksPage = (page: Page) => page.locator(".nexus-tasks");
const taskRows = (page: Page) => tasksPage(page).locator(".nt-home-grid > li, .nt-task-list > li");

async function fixture(page: Page, overrides: Partial<FixtureState> = {}) {
  const state: FixtureState = { data: snapshot(), serviceCount: 6, failure: false, methods: [], ...overrides };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/tasks") {
      state.methods.push(route.request().method());
      if (state.hold) await state.hold;
      if (state.failure) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "synthetic_task_failure" }) });
        return;
      }
    }
    const payload = path === "/api/auth/status" ? { bootstrapped: true }
      : path === "/api/auth/me" ? { user: { id: 1, email: "synthetic-home@example.invalid", role: "admin", createdAt: stamp } }
      : path === "/api/groups" ? { groups: [{ id: 1, name: "日常空间", slug: "synthetic", color: "#367d83", sortOrder: 1, createdAt: stamp }] }
      : path === "/api/services" ? { services: Array.from({ length: state.serviceCount }, (_, index) => ["影音资料库", "云端文件", "阅读空间", "网络工具", "自动化", "随手笔记"][index % 6] + (index >= 6 ? " " + (index + 1) : "")).map((name, index) => ({
        id: index + 1, groupId: 1, name, slug: "synthetic-" + index,
        description: ["收藏的电影与音乐", "文件与资料，随时取用", "留给阅读的一方空间", "连接和网络小工具", "让日常事务按时完成", "记录想法与片刻灵感"][index % 6],
        url: "https://example.invalid/service-" + index, healthUrl: null, icon: null, tags: ["合成示例"],
        status: index === 0 ? "healthy" : "unknown", latencyMs: index === 0 ? 24 : null,
        lastCheckedAt: index === 0 ? stamp : null, enabled: true, sortOrder: index, createdAt: stamp, updatedAt: stamp,
      })) }
      : path === "/api/tasks" ? { snapshot: state.data }
      : path === "/api/events" ? { events: [] }
      : path === "/api/integrations" ? { snapshot: { version: 1, mode: "unconfigured", observedAt: stamp, connections: [], available: [] } }
      : { error: "unexpected_synthetic_request" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
  await expect(page.locator("article.nexus-service-card")).toHaveCount(state.serviceCount);
  return state;
}
async function noOverflow(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
}
async function openTaskCenter(page: Page) {
  await page.getByRole("button", { name: "进入管理", exact: true }).click();
  await page.locator(".sidebar").getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "任务中心", exact: true })).toBeVisible();
}

test("首页服务下方展示只读任务列表，排序与后台任务中心保持一致", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page, { data: snapshot({ tasks: [
    task("未知周期", { kind: "cron", schedule: "0 * * * *" }),
    task("估算备份", { nextRunAt: after(20), nextRunKind: "estimated" }),
    task("确认同步", { nextRunAt: after(20), nextRunKind: "authoritative" }),
    task("已停用备份", { enabled: false, nextRunAt: after(5), nextRunKind: "authoritative" }),
  ] }) });
  await expect(page.locator(".nx-schedule-section")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toBeVisible();
  await expect(page.locator("article.nexus-service-card").first()).toBeInViewport();
  const gallery = await page.locator(".nx-directory").boundingBox();
  const schedule = await page.locator(".nx-schedule-section").boundingBox();
  expect(schedule!.y).toBeGreaterThanOrEqual(gallery!.y + gallery!.height);
  await expect(taskRows(page).locator("h3")).toHaveText(["确认同步", "估算备份", "已停用备份", "未知周期"]);
  await expect(tasksPage(page).getByRole("button", { name: /执行|运行|编辑|删除|重启/ })).toHaveCount(0);
  await openTaskCenter(page);
  await expect(taskRows(page).nth(0)).toContainText("确认同步");
  await expect(taskRows(page).nth(1)).toContainText("估算备份");
  await expect(taskRows(page).filter({ hasText: "已停用备份" })).toContainText("已停用");
  await expect(tasksPage(page)).toContainText("仅部分可见");
  await expect(tasksPage(page).getByRole("button", { name: /执行|运行|编辑|删除|重启/ })).toHaveCount(0);
});

test("首页任务区独立刷新不重载服务，加载或失败不阻碍服务入口", async ({ page }) => {
  let serviceReads = 0;
  page.on("request", req => { if (new URL(req.url()).pathname === "/api/services") serviceReads++; });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const state = await fixture(page, { hold, failure: true });
  const baseline = serviceReads;
  await expect(page.locator("article.nexus-service-card")).toHaveCount(6);
  await expect(page.locator(".nx-schedule-section")).toHaveCount(1);
  try {
    await expect(tasksPage(page)).toHaveAttribute("aria-busy", "true");
    await expect(tasksPage(page).getByRole("button", { name: "刷新定时任务快照", exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(tasksPage(page).locator(".nt-error")).toContainText("任务读取失败");
  state.failure = false;
  await tasksPage(page).getByRole("button", { name: "重试读取任务", exact: true }).click();
  await expect(taskRows(page)).toHaveCount(1);
  expect(state.methods.every(method => method === "GET")).toBe(true);
  expect(serviceReads).toBe(baseline);
});

test("首页任务区刷新失败保留旧记录并显示错误，重试成功后恢复", async ({ page }) => {
  const state = await fixture(page, { data: snapshot({ tasks: [task("已完成归档", { state: "succeeded", exitCode: 0, lastFinishedAt: before(5) })] }) });
  await expect(taskRows(page)).toContainText("上次成功");
  state.failure = true;
  await tasksPage(page).getByRole("button", { name: "刷新定时任务快照", exact: true }).click();
  await expect(tasksPage(page).locator(".nt-error")).toContainText("任务读取失败");
  await expect(taskRows(page)).toContainText("已完成归档");
  state.failure = false;
  await tasksPage(page).getByRole("button", { name: "重试读取任务", exact: true }).click();
  await expect(taskRows(page)).toContainText("上次成功");
});

for (const mode of ["demo", "unconfigured"] as const) {
  test("首页定时任务区与后台均保留" + mode + "来源边界", async ({ page }) => {
    await fixture(page, { data: snapshot({ mode, tasks: mode === "demo" ? [task("合成完成", { state: "succeeded", exitCode: 0 })] : [] }) });
    await expect(page.locator(".nx-schedule-section .nexus-tasks.nt-embedded")).toHaveCount(1);
    if (mode === "demo") {
      await expect(tasksPage(page)).toContainText("演示数据");
      await expect(taskRows(page)).toHaveCount(1);
      await taskRows(page).getByRole("button", { name: "查看任务 合成完成 详情", exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("演示数据 · 不对应家庭服务");
      await page.keyboard.press("Escape");
    } else {
      await expect(tasksPage(page)).toContainText("还没有可展示的任务");
      await expect(taskRows(page)).toHaveCount(0);
      await expect(tasksPage(page)).toContainText("没有记录不等于所有任务已停止");
    }
    await openTaskCenter(page);
    if (mode === "demo") {
      await expect(tasksPage(page)).toContainText("演示数据");
      await expect(tasksPage(page)).toContainText("未连接家庭服务");
      await expect(taskRows(page)).toHaveCount(1);
    } else {
      await expect(tasksPage(page)).toContainText("尚未接入任务来源");
      await expect(taskRows(page)).toHaveCount(0);
    }
  });
}

test("首页任务区双主题、窄屏、200%文本和键盘均可用", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page, { data: snapshot({ tasks: [task("很长的合成定时任务名称用于验证移动布局不会遮挡或截断关键时间信息LongUnbrokenTaskName", { nextRunAt: after(10), nextRunKind: "estimated", serviceName: "AnExtremelyLongSyntheticServiceWithoutWordBoundaries" })] }) });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [320, 375, 844, 1440]) {
      await page.setViewportSize({ width, height: width === 844 ? 390 : 1000 });
      await noOverflow(page);
    }
  }
  await page.setViewportSize({ width: 320, height: 1000 });
  await tasksPage(page).evaluate(root => {
    const entries = [...root.querySelectorAll("*")].filter(element => element instanceof HTMLElement).map(element => ({ element: element as HTMLElement, size: parseFloat(getComputedStyle(element).fontSize) }));
    entries.forEach(({ element, size }) => { element.style.fontSize = size * 2 + "px"; });
  });
  await noOverflow(page);
  const small = await page.locator(".nexus-tasks button").evaluateAll(elements => elements.filter(element => {
    const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && (box.width < 43.5 || box.height < 43.5);
  }).map(element => element.getAttribute("aria-label") || element.textContent));
  expect(small).toEqual([]);
  const details = taskRows(page).getByRole("button", { name: /^查看任务/ });
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await noOverflow(page);
  await page.keyboard.press("Escape");
  await expect(details).toBeFocused();
  await page.screenshot({ path: evidenceRoot + '/home-enlarged-' + test.info().project.name + ".png", fullPage: true, animations: "disabled" });
});

test("保留云端首页四种视觉记录", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page, { data: snapshot({ tasks: [
    task("资料归档", { nextRunAt: after(25), nextRunKind: "authoritative" }),
    task("索引整理", { state: "running", lastStartedAt: before(2), serviceName: "合成阅读服务" }),
    task("配置备份", { nextRunAt: after(90), nextRunKind: "authoritative", serviceName: "合成自动化" }),
    task("文件同步", { state: "succeeded", exitCode: 0, lastFinishedAt: before(15), serviceName: "合成文件服务" }),
  ] }) });
  await expect(page.locator(".nx-schedule-section")).toHaveCount(1);
  await mkdir(evidenceRoot, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: evidenceRoot + '/home-desktop-' + theme + ".png", fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 375, height: 812 });
    await noOverflow(page);
    await page.screenshot({ path: evidenceRoot + '/home-mobile-' + theme + ".png", fullPage: true, animations: "disabled" });
  }
});

test("23个入口的手机与桌面看板全部可访问且无定时任务插队", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page, { serviceCount: 23 });
  await expect(page.locator("article.nexus-service-card")).toHaveCount(23);
  await expect(page.locator(".nx-schedule-section")).toHaveCount(1);
  await page.locator("article.nexus-service-card").last().scrollIntoViewIfNeeded();
  await expect(page.locator("article.nexus-service-card").last().locator("a.nexus-service-open")).toHaveAttribute("href", "https://example.invalid/service-22");
  await noOverflow(page);
});

test("375px手机端看板支持同行多卡不规则错落排布且无横向溢出", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 375, height: 812 });
  await fixture(page, { serviceCount: 9 });
  const boxes = await page.locator("article.nexus-service-card").evaluateAll((cards) =>
    cards.map((card) => {
      const r = card.getBoundingClientRect();
      return { top: Math.round(r.top), width: Math.round(r.width) };
    }),
  );
  expect(boxes).toHaveLength(9);
  expect(Math.abs(boxes[0]!.top - boxes[1]!.top)).toBeLessThanOrEqual(4);
  expect(boxes[0]!.width).toBeGreaterThan(boxes[1]!.width + 20);
  expect(Math.abs(boxes[6]!.top - boxes[7]!.top)).toBeLessThanOrEqual(4);
  expect(Math.abs(boxes[7]!.top - boxes[8]!.top)).toBeLessThanOrEqual(4);
  await noOverflow(page);
});

for (const scenario of [
  { name: "已保存深色", saved: true, blocked: false, expected: "dark" },
  { name: "存储不可读", saved: false, blocked: true, expected: "dark" },
]) {
  test("客户端脚本加载前首帧主题正确：" + scenario.name, async ({ page }) => {
    await page.addInitScript(({ saved, blocked }) => {
      if (saved) localStorage.setItem("nexus-theme", "dark");
      if (blocked) Object.defineProperty(Storage.prototype, "getItem", {
        configurable: true, value() { throw new DOMException("Synthetic storage blocked", "SecurityError"); },
      });
    }, scenario);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/assets/*.js", async route => { await pending; await route.continue(); });
    const ready = fixture(page);
    try {
      await expect(page.locator("html")).toHaveAttribute("data-theme", scenario.expected);
      await expect(page.locator("#root")).toBeEmpty();
    } finally { release(); }
    await ready;
    await expect(page.locator("html")).toHaveAttribute("data-theme", scenario.expected);
  });
}

test("各尺寸首页管理入口保持44px，后台菜单圈定焦点并恢复", async ({ page }) => {
  await fixture(page);
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    await expect(page.locator(".nx-top-utility button")).toHaveCount(1);
    const small = await page.locator(".nx-top-utility button").evaluateAll(elements => elements.filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden" && (box.width < 43.5 || box.height < 43.5);
    }).map(element => ({ name: element.getAttribute("aria-label") || element.textContent, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
    expect(small).toEqual([]);
  }
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.getByRole("button",{name:"进入管理",exact:true}).click();
  await page.setViewportSize({width:375,height:900});
  const opener = page.getByRole("button", { name: "打开导航", exact: true });
  await expect(page.locator(".sidebar")).toHaveJSProperty("inert", true);
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "导航", exact: true });
  await expect(dialog).toBeVisible();
  expect(await page.locator(".sidebar").evaluate(element => (element as HTMLElement).inert)).toBe(false);
  expect(await page.locator("main.main").evaluate(element => (element as HTMLElement).inert)).toBe(true);
  for (let count = 0; count < 24; count++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  expect(await page.locator(".sidebar").evaluate(element => (element as HTMLElement).inert)).toBe(true);
  expect(await page.locator("main.main").evaluate(element => (element as HTMLElement).inert)).toBe(false);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
});

test("网站完整九服务与嵌入定时任务及分组后台视觉验收",async({page})=>{
 await page.setViewportSize({width:1440,height:1000});
 await fixture(page,{serviceCount:9,data:snapshot({mode:"demo",tasks:[
 task("资料归档",{state:"running",lastStartedAt:before(1)}),
 task("云端同步",{nextRunAt:after(25),nextRunKind:"authoritative"}),
 task("阅读索引",{nextRunAt:after(80),nextRunKind:"estimated"}),
 task("每周备份",{state:"succeeded",exitCode:0,lastFinishedAt:before(40)})
 ]})});
 await mkdir(evidenceRoot,{recursive:true});
 await expect(page.locator(".nx-schedule-section")).toHaveCount(1);
 await page.screenshot({path:evidenceRoot+"/website-nine-desktop.png",fullPage:true,animations:"disabled"});
 await page.setViewportSize({width:375,height:900});await noOverflow(page);
 await page.screenshot({path:evidenceRoot+"/website-nine-mobile.png",fullPage:true,animations:"disabled"});
 await page.setViewportSize({width:1440,height:1000});await openTaskCenter(page);await expect(taskRows(page)).toHaveCount(4);
 await page.locator(".sidebar nav").getByRole("button",{name:"分组管理",exact:true}).click();
 await page.screenshot({path:evidenceRoot+"/website-groups-desktop.png",fullPage:true});
});
