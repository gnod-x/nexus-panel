import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { Store } from '../../src/server/db.js';

describe('client static serving', () => {
  const previousClientDist = process.env.CLIENT_DIST;
  let temporaryClientDist: string | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let store: Store | undefined;

  afterEach(async () => {
    if (app) await app.close();
    store?.db.close();
    if (temporaryClientDist) await rm(temporaryClientDist, { recursive: true, force: true });
    if (previousClientDist === undefined) delete process.env.CLIENT_DIST;
    else process.env.CLIENT_DIST = previousClientDist;
  });

  it('serves the SPA root as UTF-8 HTML', async () => {
    temporaryClientDist = await mkdtemp(path.join(os.tmpdir(), 'nexus-client-'));
    await writeFile(
      path.join(temporaryClientDist, 'index.html'),
      '<!doctype html><html><body><main>Nexus test shell</main></body></html>',
      'utf8',
    );
    process.env.CLIENT_DIST = temporaryClientDist;
    store = new Store(':memory:');
    app = buildApp(store);
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('Nexus test shell');
  });
});
