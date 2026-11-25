import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { Store } from '../../src/server/db.js';
describe('email normalization keeps password unchanged', () => {
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  let store: Store;
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    delete process.env.PUBLIC_ORIGIN;
    store = new Store(':memory:');
    app = buildApp(store);
  });
  afterEach(async () => {
    await app.close();
    store.db.close();
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
  });
  it('normalizes full-width email punctuation/outer spaces at bootstrap and login without trimming password', async () => {
    const password = '  ephemeral synthetic phrase  ';
    const headers = { 'content-type': 'application/json' };
    const created = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers, payload: { email: ' Synthetic＠example。test ', password } });
    expect(created.statusCode).toBe(201);
    expect(created.json().user.email).toBe('Synthetic@example.test');
    const loggedIn = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email: ' Synthetic＠example．test ', password } });
    expect(loggedIn.statusCode).toBe(200);
    const trimmedPassword = await app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { email: 'Synthetic@example.test', password: password.trim() } });
    expect(trimmedPassword.statusCode).toBe(401);
  });
  it('rejects genuinely malformed email without creating a user', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers: { 'content-type': 'application/json' }, payload: { email: 'malformed-email', password: 'ephemeral synthetic phrase' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_input');
    expect(store.userCount()).toBe(0);
  });
});
