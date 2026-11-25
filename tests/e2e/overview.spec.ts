const evidenceRoot = process.env.E2E_ARTIFACT_ROOT || "artifacts/home-refresh";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const timestamp = "2026-11-20T10:00:00.000Z";
const makeService = (id: number, status: string, latencyMs: number | null) => ({
  id, groupId: id > 4 ? 2 : 1,
  name: ["Media Library", "Cloud Workspace", "Network Gateway", "Archive Storage", "Long Synthetic Workspace and Media Collection", "家庭实验室的长名称服务入口用于移动布局验证", "Seventh Service"][id - 1],
  slug: "service-" + id, description: "Synthetic service fixture for dashboard verification",
  url: "https://example.test/service-" + id, healthUrl: null, icon: null,
  tags: ["synthetic", "personal"], status, latencyMs, lastCheckedAt: status === "unknown" ? null : timestamp,
  enabled: true, sortOrder: id, createdAt: timestamp, updatedAt: timestamp,
});
const services = [makeService(1, "healthy", 20), makeService(2, "healthy", 40), makeService(3, "offline", 120), makeService(4, "unknown", null), makeService(5, "unknown", null), makeService(6, "unknown", null), makeService(7, "unknown", null)];
async function fixture(page: Page, rows = services) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const payload = path === "/api/auth/status" ? { bootstrapped: true }
      : path === "/api/auth/me" ? { user: { id: 1, email: "synthetic@example.test", role: "admin", createdAt: timestamp } }
      : path === "/api/services" ? { services: rows }
      : path === "/api/groups" ? { groups: [{ id: 1, name: "Personal Space", slug: "personal", color: "#67e8b0", sortOrder: 1, createdAt: timestamp }, { id: 2, name: "Media and Storage", slug: "media", color: "#9a8dec", sortOrder: 2, createdAt: timestamp }] }
      : path === "/api/events" ? { events: [{ id: 1, serviceId: 1, type: "health_check", message: "Synthetic service check completed", metadata: {}, createdAt: timestamp }] }
      : path === "/api/tasks" ? { snapshot: { version: 1, mode: "unconfigured", freshness: "unknown", observedAt: timestamp, tasks: [], sources: [] } }
      : path === "/api/integrations" ? { snapshot: { version: 1, mode: "unconfigured", observedAt: timestamp, connections: [], available: [] } }
      : { error: "unexpected_test_request" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
}
async function toggleHomepageTheme(page: Page) {
  await page.getByRole("button", { name: "进入管理", exact: true }).click();
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.getByRole("main").getByRole("button", { name: "返回首页", exact: true }).click();
  await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
}
async function noOverflow(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, width: document.documentElement.scrollWidth }));
  const offenders = await page.locator("body *").evaluateAll((elements) => elements.filter((element) => { const box = element.getBoundingClientRect(); return box.right > window.innerWidth + 0.5 && box.width > 0; }).map((element) => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right })));
  expect(dimensions.width, JSON.stringify(offenders)).toBeLessThanOrEqual(dimensions.viewport);
}
const card = (page: Page, name: string) => page.locator("article.nexus-service-card").filter({ has: page.locator("strong").filter({ hasText: new RegExp("^" + name + "$") }) });

test("首屏直接显示服务看板，无搜索和筛选栏且链接与详情独立可用", async ({ page }) => {
  await fixture(page);
  await expect(page.locator("article.nexus-service-card")).toHaveCount(7);
  await expect(page.locator("article.nexus-service-card").first()).toBeInViewport();
  await expect(page.locator(".nexus-home-search, .nexus-group-filters, .nx-secondary, .nx-attention, .nx-health-rate, .nx-event-list")).toHaveCount(0);
  const firstCard = card(page, "Media Library");
  await expect(firstCard).not.toContainText("Synthetic service fixture for dashboard verification");
  const directLink = firstCard.locator("a.nexus-service-open");
  await expect(directLink).toHaveAttribute("href", "https://example.test/service-1");
  await expect(directLink).toHaveAttribute("target", "_blank");
  await expect(directLink).toHaveAttribute("rel", "noopener noreferrer");
  await firstCard.locator("button.nexus-card-details").click();
  await expect(page.getByRole("dialog", { name: "Media Library", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭服务详情" }).click();
  await page.keyboard.press("Control+k");
  await expect(page.getByLabel("服务搜索关键词")).toBeFocused();
  await page.getByLabel("服务搜索关键词").fill("Media Library");
  await expect(page.locator(".command-results > button")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("首页无搜索和筛选标签，收藏切换独立可用且收藏优先", async ({ page }) => {
  await fixture(page);
  await expect(page.locator(".nexus-home-search, .nexus-group-filters")).toHaveCount(0);
  await expect(page.locator("article.nexus-service-card")).toHaveCount(7);
  await card(page, "Seventh Service").locator(".nexus-card-favorite").click();
  await expect(page.locator("article.nexus-service-card").first().locator("strong")).toHaveText("Seventh Service");
  await expect(page.locator("article.nexus-service-card").first().locator(".nexus-card-favorite")).toHaveAttribute("aria-pressed", "true");
  await card(page, "Seventh Service").locator(".nexus-card-favorite").click();
  await expect(card(page, "Seventh Service").locator(".nexus-card-favorite")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("article.nexus-service-card").first().locator("strong")).toHaveText("Media Library");
  await card(page, "Seventh Service").locator(".nexus-card-favorite").click();
  await expect(page.locator("article.nexus-service-card").first().locator("strong")).toHaveText("Seventh Service");
});

test("服务状态不推断未检查结果，成功空目录才展示创建入口", async ({ page }) => {
  await fixture(page, [makeService(4, "unknown", null)]);
  await expect(page.locator("article.nexus-service-card")).toHaveCount(1);
  await expect(page.locator(".nx-service-status")).toHaveCount(0);
  await page.locator(".nexus-card-details").click();await expect(page.getByRole("dialog")).toContainText("未检查");await page.keyboard.press("Escape");
  await expect(page.locator("article.nexus-service-card")).not.toContainText(/正常率|全部正常/);
  await page.unroute("**/api/**");
  await fixture(page, [makeService(3, "offline", 120)]);
  await page.locator(".nexus-card-details").click();await expect(page.getByRole("dialog")).toContainText("离线");await page.keyboard.press("Escape");
  await page.unroute("**/api/**");
  await fixture(page, []);
  await expect(page.getByText("还没有服务", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "进入管理",exact:true })).toBeVisible();
});

test("双主题在手机平板桌面无溢出，移动触控尺寸可用", async ({ page }) => {
  await fixture(page);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await noOverflow(page);
      await expect(page.locator("article.nexus-service-card").first()).toBeVisible();
      const overlappingTargets = await page.locator("article.nexus-service-card").evaluateAll((cards) => cards.flatMap((card) => {
        const link = card.querySelector("a.nexus-service-open");
        if (!link) return [];
        const linkBox = link.getBoundingClientRect();
        return Array.from(card.querySelectorAll(".nexus-card-favorite, .nexus-card-details")).flatMap((button) => {
          const buttonBox = button.getBoundingClientRect();
          const intersectionWidth = Math.min(linkBox.right, buttonBox.right) - Math.max(linkBox.left, buttonBox.left);
          const intersectionHeight = Math.min(linkBox.bottom, buttonBox.bottom) - Math.max(linkBox.top, buttonBox.top);
          return intersectionWidth > .01 && intersectionHeight > .01
            ? [{ service: link.textContent?.trim(), button: button.getAttribute("aria-label"), intersectionWidth, intersectionHeight }]
            : [];
        });
      }));
      expect(overlappingTargets, `${theme} at ${width}px: service links must not overlap favorite/details hit areas`).toEqual([]);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const smallTargets = await page.locator(".nexus-home button, .nexus-home input, .nexus-home summary, .nexus-home a.nexus-service-open").evaluateAll((elements) => elements.filter((element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && (box.height < 43.5 || box.width < 43.5);
  }).map((element) => ({ text: element.textContent, label: element.getAttribute("aria-label"), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
  expect(smallTargets).toEqual([]);
  const tinyText = await page.locator(".nexus-home *").evaluateAll((elements) => elements.filter((element) => element.childNodes.length && Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) && element.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(element).fontSize) < 12).map((element) => ({ text: element.textContent, size: getComputedStyle(element).fontSize })));
  expect(tinyText).toEqual([]);
  await page.getByRole("button", { name: "进入管理", exact:true }).click();
  await page.getByRole("button", { name: /^打开导航(?:菜单)?$/ }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.getByRole("button", { name: "关闭导航" }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await noOverflow(page);
});

test("主题切换和键盘导航支持减少动态效果", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  for (const expected of ["light", "dark"]) {
    await toggleHomepageTheme(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", expected);
    const details = card(page, "Media Library").locator(".nexus-card-details");
    await details.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Media Library", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    const tileLink = card(page, "Media Library").locator("a.nexus-service-open");
    await tileLink.focus();
    await expect(tileLink).toBeFocused();
    const focus = await tileLink.evaluate((element) => {
      const styles = getComputedStyle(element);
      const parent = element.parentElement ? getComputedStyle(element.parentElement) : null;
      return { outline: styles.outlineStyle, parentOutline: parent?.outlineStyle, parentShadow: parent?.boxShadow };
    });
    expect(focus.outline !== "none" || focus.parentOutline !== "none" || focus.parentShadow !== "none").toBe(true);
  }
});

test("保留云端工作台视觉记录", async ({ page }) => {
  await fixture(page);
  await mkdir(evidenceRoot, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: evidenceRoot + '/overview-dark.png', fullPage: true, animations: "disabled" });
  await toggleHomepageTheme(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: evidenceRoot + '/overview-light.png', fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: evidenceRoot + '/overview-mobile-light.png', fullPage: true, animations: "disabled" });
});

async function textContrast(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) => {
    const rgb = (value: string) => {
      const values = value.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) || [0, 0, 0];
      if (/^color\(srgb\b/i.test(value)) {
        return [values[0] * 255, values[1] * 255, values[2] * 255, values[3] ?? 1];
      }
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const luminance = (color: number[]) => color.slice(0, 3).map((component) => { const value = component / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    return elements.filter((element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0).map((element) => {
      let background = [255, 255, 255, 1];
      const ancestors: Element[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) ancestors.push(current);
      for (const ancestor of ancestors.reverse()) {
        const color = rgb(getComputedStyle(ancestor).backgroundColor);
        background = color.slice(0, 3).map((value, index) => value * color[3] + background[index] * (1 - color[3])).concat(1);
      }
      const style = getComputedStyle(element);
      const foreground = rgb(style.color);
      const a = luminance(foreground), b = luminance(background);
      return { text: element.textContent?.trim().slice(0, 60), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), min: parseFloat(style.fontSize) >= 24 ? 3 : 4.5 };
    });
  });
}

test("工作台双主题正文和服务状态文本对比度可读", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForTimeout(350); // Sample settled theme colors, not inherited color transitions.
    const results = await textContrast(page, ".nexus-home h1, .nx-tile-link strong, .nx-tile-link span, .nx-service-status, .nexus-group-filters button");
    expect(results.filter((result) => result.ratio + .01 < result.min), theme + JSON.stringify(results)).toEqual([]);
  }
});


test("首页服务看板下嵌入只读定时任务，管理显式进入独立后台", async ({ page }) => {
  await fixture(page);
  await expect(page.locator(".sidebar, .nx-more, .nx-service-status")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "定时任务", exact: true })).toBeVisible();
  await expect(page.locator(".nexus-tasks.nt-embedded")).toHaveCount(1);
  await expect(page.locator(".website-topbar, .website-nav, .nexus-home-search, .nexus-group-filters")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(添加服务|刷新数据|首页|定时任务)$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "进入管理", exact: true }).click();
  await expect(page).toHaveURL(/#\/manage\/services$/);
  await expect(page.locator(".admin-shell .sidebar")).toBeVisible();
  await page.locator(".sidebar").getByRole("button", { name: "任务中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "任务中心", exact: true })).toBeVisible();
  await expect(page.locator(".nexus-tasks.nt-embedded")).toHaveCount(0);
});

test("320px和200%文字仍可访问服务和独立操作", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  await fixture(page);
  await page.locator(".nexus-home").evaluate((root) => {
    const entries = Array.from(root.querySelectorAll("*")).map((element) => ({ element: element as HTMLElement, size: parseFloat(getComputedStyle(element).fontSize) }));
    entries.forEach(({ element, size }) => { element.style.fontSize = size * 2 + "px"; });
  });
  await noOverflow(page);
  for (const tile of await page.locator("article.nexus-service-card").all()) {
    const overlap = await tile.evaluate((element) => {
      const link = element.querySelector("a.nexus-service-open")!.getBoundingClientRect();
      return Array.from(element.querySelectorAll(".nexus-card-favorite, .nexus-card-details")).some((button) => {
        const box = button.getBoundingClientRect();
        return Math.min(link.right, box.right) - Math.max(link.left, box.left) > .01 && Math.min(link.bottom, box.bottom) - Math.max(link.top, box.top) > .01;
      });
    });
    expect(overlap).toBe(false);
  }
  await page.getByRole("button",{name:"进入管理",exact:true}).focus();
  await expect(page.getByRole("button",{name:"进入管理",exact:true})).toBeFocused();
});
