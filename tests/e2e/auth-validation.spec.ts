const evidenceRoot = process.env.E2E_ARTIFACT_ROOT || "artifacts/home-refresh";
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function authFixture(page: Page, bootstrapped = false) {
  await page.route("**/api/auth/status", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ bootstrapped }),
  }));
  await page.route("**/api/auth/me", (route) => route.fulfill({
    status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }),
  }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: bootstrapped ? "登录面板" : "创建管理员", exact: true })).toBeVisible();
}
test("邮箱归一化后提交，密码保留首尾空格且提交中不能重复提交", async ({ page }) => {
  let requests = 0;
  let emailMatches = false;
  let passwordMatches = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const originalPassword = "  synthetic password remains unchanged  ";
  await page.route("**/api/auth/bootstrap", async (route) => {
    requests++;
    const payload = route.request().postDataJSON();
    emailMatches = payload.email === "Synthetic@example.test";
    passwordMatches = payload.password === originalPassword;
    await gate;
    await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "origin_forbidden" }) });
  });
  await authFixture(page);
  await page.getByLabel("邮箱", { exact: true }).fill("  Synthetic＠example。test  ");
  await page.getByLabel("密码", { exact: true }).fill(originalPassword);
  await page.getByRole("button", { name: "显示密码", exact: true }).click();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "隐藏密码", exact: true }).click();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "创建管理员", exact: true }).click();
  await expect(page.locator("button[type=submit]")).toBeDisabled();
  await page.locator("form").evaluate((form) => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(requests).toBe(1);
  expect(emailMatches).toBe(true);
  expect(passwordMatches).toBe(true);
  release();
  await expect(page.locator(".nexus-auth-summary")).toBeVisible();
  await expect(page.locator(".nexus-auth-summary")).toBeFocused();
});

test("无效邮箱和短密码就地提示，不发送网络请求并可修正", async ({ page }) => {
  let submissions = 0;
  await page.route("**/api/auth/bootstrap", (route) => { submissions++; return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_input" }) }); });
  await authFixture(page);
  await page.getByLabel("邮箱", { exact: true }).fill("not-an-email");
  await page.getByLabel("密码", { exact: true }).fill("short");
  await page.getByRole("button", { name: "创建管理员", exact: true }).click();
  await expect(page.getByLabel("邮箱", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".nexus-auth-field-error")).toHaveCount(2);
  await expect(page.locator(".nexus-auth-summary")).toBeFocused();
  expect(submissions).toBe(0);
  await page.getByLabel("邮箱", { exact: true }).fill("correct@example.test");
  await page.getByLabel("密码", { exact: true }).fill("synthetic long password");
  await expect(page.locator(".nexus-auth-field-error")).toHaveCount(0);
});

test("认证页双主题多尺寸、触控、字体和键盘焦点可用", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await authFixture(page);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
      expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
    }
    const email = page.getByLabel("邮箱", { exact: true });
    await email.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("密码", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "显示密码", exact: true })).toBeFocused();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const bad = await page.locator(".nexus-auth-form button, .nexus-auth-form input").evaluateAll((elements) => elements.filter((element) => { const box = element.getBoundingClientRect(); return box.width < 43.5 || box.height < 43.5; }).map((element) => ({ label: element.getAttribute("aria-label"), height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width })));
  expect(bad).toEqual([]);
  const tiny = await page.locator(".nexus-auth-form *").evaluateAll((elements) => elements.filter((element) => element.getBoundingClientRect().width > 0 && Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) && parseFloat(getComputedStyle(element).fontSize) < 12).map((element) => ({ text: element.textContent, size: getComputedStyle(element).fontSize })));
  expect(tiny).toEqual([]);
});

test("登录允许已有短密码，保留密码管理器语义", async ({ page }) => {
  let submitted = false;
  await page.route("**/api/auth/login", async (route) => {
    submitted = route.request().postDataJSON().password === "old";
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "invalid_credentials" }) });
  });
  await authFixture(page, true);
  await expect(page.getByLabel("邮箱", { exact: true })).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("autocomplete", "current-password");
  await page.getByLabel("邮箱", { exact: true }).fill("synthetic@example.test");
  await page.getByLabel("密码", { exact: true }).fill("old");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".nexus-auth-summary")).toBeVisible();
  expect(submitted).toBe(true);
});

test("保留云端认证视觉记录", async ({ page }) => {
  await authFixture(page);
  await mkdir(evidenceRoot, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: evidenceRoot + '/auth-dark.png', fullPage: true, animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.screenshot({ path: evidenceRoot + '/auth-light.png', fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: evidenceRoot + '/auth-mobile.png', fullPage: true, animations: "disabled" });
});

async function textContrast(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) => {
    const rgb = (value: string) => {
      const values = value.match(/[0-9.]+/g)?.map(Number) || [0, 0, 0];
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

test("认证页双主题标题、帮助文案和输入文字对比度可读", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await authFixture(page);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForTimeout(350); // Sample settled theme colors, not inherited color transitions.
    const results = await textContrast(page, ".nexus-auth-intro h1, .nexus-auth-intro p, .nexus-auth-field > label, .nexus-auth-hint, .nexus-auth-field input, .nexus-auth-submit, .nexus-auth-bottom, .nexus-auth-story-copy > p, .nexus-auth-story-copy h2, .nexus-auth-story-foot");
    expect(results.filter((result) => result.ratio + .01 < result.min), theme + JSON.stringify(results)).toEqual([]);
  }
});
