import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { resolveTarget } from './security.js';

export function healthTimeoutMs(value = process.env.HEALTH_TIMEOUT_MS): number {
  const configured = value?.trim() ? Number(value) : 5000;
  if (!Number.isFinite(configured)) return 5000;
  return Math.trunc(Math.min(Math.max(configured, 500), 15000));
}

export async function probeHealth(target: string): Promise<number> {
  const controller = new AbortController();
  const { signal } = controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Health check deadline exceeded');
      controller.abort(error);
      reject(error);
    }, healthTimeoutMs());
  });
  const probe = async () => {
    const { url, address } = await resolveTarget(target);
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const transport = url.protocol === 'https:' ? https : http;
    const options: https.RequestOptions = {
      hostname: address,
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers: { host: url.host, 'user-agent': 'NexusPanel-Health/1.0' },
      agent: false,
      signal,
      servername: net.isIP(hostname) ? '' : hostname,
      checkServerIdentity: (_host, cert) => tls.checkServerIdentity(hostname, cert),
    };
    return new Promise<number>((resolve, reject) => {
      const request = transport.request(options, response => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      });
      request.once('error', reject);
      request.end();
    });
  };
  try {
    return await Promise.race([probe(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
