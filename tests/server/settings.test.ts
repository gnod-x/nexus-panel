import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../../src/server/app.js";
import { Store } from "../../src/server/db.js";
import { AppSettings } from "../../src/server/settings.js";
import { randomToken, tokenHash } from "../../src/server/security.js";

describe("homepage font settings", () => {
  let store: Store;
  let app: ReturnType<typeof buildApp>;
  let settings: AppSettings;
  let directory: string;
  let sessionNumber = 0;
  beforeEach(() => {
    sessionNumber = 0;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-home-font-"));
    store = new Store(":memory:");
    settings = new AppSettings(path.join(directory, "settings.json"));
    app = buildApp(store, settings);
  });
  afterEach(async () => {
    await app.close();
    store.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function session(role: "admin" | "operator" | "viewer") {
    const user = store.createUser(role + "-" + ++sessionNumber + "@example.test", "synthetic-password-hash", role);
    const token = randomToken();
    store.saveSession(tokenHash(token), user.id, new Date(Date.now() + 60_000).toISOString());
    return "nexus_session=" + token;
  }
  it("requires an authenticated session to read, and returns the default font", async () => {
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url: "/api/settings", headers: { cookie: session("viewer") } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ homeFont: "calligraphy" });
  });
  it("allows only admins to update a fixed font choice", async () => {
    const operator = await app.inject({ method: "PATCH", url: "/api/settings", headers: { cookie: session("operator") }, payload: { homeFont: "sans" } });
    expect(operator.statusCode).toBe(403);
    const viewer = await app.inject({ method: "PATCH", url: "/api/settings", headers: { cookie: session("viewer") }, payload: { homeFont: "sans" } });
    expect(viewer.statusCode).toBe(403);
    const invalid = await app.inject({ method: "PATCH", url: "/api/settings", headers: { cookie: session("admin") }, payload: { homeFont: "url(javascript:alert(1))" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ error: "invalid_input" });
    const extra = await app.inject({ method: "PATCH", url: "/api/settings", headers: { cookie: session("admin") }, payload: { homeFont: "sans", css: "body { font-family: serif }" } });
    expect(extra.statusCode).toBe(400);
    const saved = await app.inject({ method: "PATCH", url: "/api/settings", headers: { cookie: session("admin") }, payload: { homeFont: "serif" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ homeFont: "serif" });
    expect(settings.getHomeFont()).toBe("serif");
  });
  it("persists the global choice across settings-store restarts", () => {
    settings.setHomeFont("kai");
    expect(new AppSettings(path.join(directory, "settings.json")).getHomeFont()).toBe("kai");
    expect(fs.statSync(path.join(directory, "settings.json")).mode & 0o777).toBe(0o600);
  });
  it("rejects corrupted persisted settings instead of applying an unknown value", () => {
    fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ version: 1, homeFont: "url(http://example.test/font)" }));
    expect(() => settings.getHomeFont()).toThrow("Application settings file is invalid");
  });
});
