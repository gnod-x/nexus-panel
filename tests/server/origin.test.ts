import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { Store } from '../../src/server/db.js';

describe('mutation origin boundary', () => {
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  let store: Store;
  const apps: ReturnType<typeof buildApp>[] = [];

  beforeEach(() => {
    delete process.env.PUBLIC_ORIGIN;
    store = new Store(':memory:');
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    expect(store.userCount()).toBe(0);
    store.db.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
  });
  function appFor(publicOrigin?: string) {
    if (publicOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = publicOrigin;
    const app = buildApp(store);
    apps.push(app);
    return app;
  }
  async function mutation(app: ReturnType<typeof buildApp>, headers: Record<string, string>) {
    return app.inject({
      method: 'POST', url: '/api/auth/bootstrap',
      headers: { 'content-type': 'application/json', host: '127.0.0.1:18085', ...headers },
      payload: {},
    });
  }
  it('keeps default same-host requests subject to input validation', async () => {
    const response = await mutation(appFor(), { origin: 'http://127.0.0.1:18085' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_input');
  });
  it('rejects a public origin by default when the proxy rewrites Host', async () => {
    const response = await mutation(appFor(), { origin: 'https://dashboard.example.test' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'origin_forbidden' });
  });
  it('allows exactly configured public HTTP or HTTPS origins behind an internal Host', async () => {
    for (const origin of ['https://dashboard.example.test', 'http://dashboard.example.test:8080']) {
      const response = await mutation(appFor(origin), { origin });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_input');
    }
  });
  it.each([
    'https://attacker.example.test',
    'https://dashboard.example.test.attacker.example.test',
    'https://notdashboard.example.test',
    'http://dashboard.example.test',
    'https://dashboard.example.test:8443',
    'https://dashboard.example.test/path',
    'https://dashboard.example.test?query=1',
    'https://dashboard.example.test#fragment',
    'https://user:pass@dashboard.example.test',
    'null',
    'file:///dashboard.example.test',
  ])('rejects unmatched or non-origin Origin header %s', async (origin) => {
    const response = await mutation(appFor('https://dashboard.example.test'), { origin });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'origin_forbidden' });
  });
  it('does not trust forged X-Forwarded-Host', async () => {
    const response = await mutation(appFor(), {
      origin: 'https://attacker.example.test',
      'x-forwarded-host': 'attacker.example.test',
      'x-forwarded-proto': 'https',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'origin_forbidden' });
  });
  it('does not regress clients without an Origin header', async () => {
    const response = await mutation(appFor('https://dashboard.example.test'), {});
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_input');
  });
  it.each([
    'not a URL', 'null', 'file:///tmp/dashboard', 'ftp://dashboard.example.test',
    'https://user:pass@dashboard.example.test',
    'https://dashboard.example.test/path',
    'https://dashboard.example.test?query=1',
    'https://dashboard.example.test#fragment',
  ])('fails fast for invalid PUBLIC_ORIGIN %s', (origin) => {
    process.env.PUBLIC_ORIGIN = origin;
    expect(() => buildApp(store)).toThrow();
  });
});

describe('production public-origin authentication flow', () => {
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  const previousEnvironment = process.env.NODE_ENV;
  let store: Store;
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_ORIGIN = 'https://dashboard.example.test';
    store = new Store(':memory:');
    app = buildApp(store);
  });
  afterEach(async () => {
    await app.close();
    store.db.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  });
  it('supports secure session bootstrap, login, me, logout and rejects foreign origins', async () => {
    const headers = {
      'content-type': 'application/json',
      host: '127.0.0.1:18085',
      origin: 'https://dashboard.example.test',
    };
    const credentials = { email: 'ephemeral-origin@example.test', password: 'ephemeral synthetic integration phrase' };
    const bootstrap = await app.inject({
      method: 'POST', url: '/api/auth/bootstrap', headers, payload: credentials,
    });
    expect(bootstrap.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', headers, payload: credentials,
    });
    expect(login.statusCode).toBe(200);
    const rawCookie = login.headers['set-cookie'];
    const setCookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie || '';
    expect(setCookie.split(';').map((part) => part.trim().toLowerCase()).includes('secure')).toBe(true);
    expect(setCookie.split(';').map((part) => part.trim().toLowerCase()).includes('httponly')).toBe(true);
    expect(setCookie.split(';').map((part) => part.trim().toLowerCase()).includes('samesite=lax')).toBe(true);
    const cookie = setCookie.split(';')[0];
    const me = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { host: headers.host, cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(credentials.email);
    const forbidden = await app.inject({
      method: 'POST', url: '/api/auth/logout',
      headers: { ...headers, cookie, origin: 'https://attacker.example.test' }, payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: 'origin_forbidden' });
    const logout = await app.inject({
      method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie }, payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
    const expired = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { host: headers.host, cookie },
    });
    expect(expired.statusCode).toBe(401);
  });
});
