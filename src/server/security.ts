import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const blockedHosts = new Set(['metadata.google.internal', 'metadata.google.com', 'instance-data.ec2.internal', 'metadata.azure.internal']);
const blockedAddresses = new Set(['169.254.169.254','169.254.170.2','100.100.100.200','fd00:ec2::254']);
const embeddedIPv4 = new net.BlockList();
embeddedIPv4.addSubnet('::ffff:0:0', 96, 'ipv6');
embeddedIPv4.addSubnet('64:ff9b::', 96, 'ipv6');
embeddedIPv4.addSubnet('64:ff9b:1::', 48, 'ipv6');
const blockedRanges = [
  '0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
  '::/128', '::1/128', '::ffff:0:0/96', '64:ff9b:1::/48', '100::/64',
  '2001::/23', '2001:db8::/32', '2002::/16', 'fe80::/10', 'ff00::/8',
];

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64).toString('base64url');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [, salt, expected] = encoded.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('base64url');
  const actualBytes=Buffer.from(actual), expectedBytes=Buffer.from(expected);
  return actualBytes.length===expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts=address.split('.').map(Number),a=parts[0]??-1,b=parts[1]??-1;
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized.startsWith('::ffff:');
  }
  return false;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, prefixText] = cidr.split('/');
  if (!base) return false;
  const family = net.isIP(ip);
  if (!family || family !== net.isIP(base)) return false;
  const prefix = Number(prefixText ?? (family === 4 ? 32 : 128));
  const bits = family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const toBig = (value: string) => {
    if (family === 4) return value.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
    let v = value.toLowerCase();
    const halves = v.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const groups = halves.length === 2 ? [...left, ...Array(8-left.length-right.length).fill('0'), ...right] : left;
    return groups.reduce((n, part) => (n << 16n) | BigInt(parseInt(part || '0',16)),0n);
  };
  const shift=BigInt(bits-prefix);
  return (toBig(ip)>>shift)===(toBig(base)>>shift);
}

async function resolveAnswers(host: string): Promise<string[]> {
  return net.isIP(host) ? [host] : (await dns.lookup(host, { all:true, verbatim:true })).map(row=>row.address);
}

function assertAnswersAllowed(addresses: string[]) {
  if (!addresses.length) throw new Error('Target host could not be resolved');
  const allowed=(process.env.HEALTH_ALLOWED_CIDRS||'').split(',').map(s=>s.trim()).filter(Boolean);
  for (const ip of addresses) {
    if (net.isIPv6(ip) && embeddedIPv4.check(ip, 'ipv6')) throw new Error('Translated target addresses are not allowed');
    if (blockedAddresses.has(ip.toLowerCase()) || inCidr(ip,'fd00:ec2::/64')) throw new Error('Metadata target is blocked');
    if (blockedRanges.some(range=>inCidr(ip,range))) throw new Error('Non-routable target is blocked');
    if (!isPrivateIp(ip)) continue;
    if (!allowed.some(c=>inCidr(ip,c))) {
      throw new Error('Private target is outside HEALTH_ALLOWED_CIDRS');
    }
  }
}

export async function validateTargetUrl(raw: string): Promise<URL> {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('Invalid target URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS targets are supported');
  if (parsed.username || parsed.password) throw new Error('Target credentials are not allowed');
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  const policyHost = host.replace(/\.$/, '');
  if (blockedHosts.has(policyHost) || blockedAddresses.has(host) || inCidr(host,'fd00:ec2::/64')) throw new Error('Target host is blocked');
  assertAnswersAllowed(await resolveAnswers(host));
  return parsed;
}

export async function resolveTarget(raw: string): Promise<{ url: URL; address: string }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid target URL'); }
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || blockedHosts.has(host.replace(/\.$/, '')) || blockedAddresses.has(host) || inCidr(host,'fd00:ec2::/64')) throw new Error('Target URL is not allowed');
  const addresses=await resolveAnswers(host);
  assertAnswersAllowed(addresses);
  const address=addresses[0];
  if(address===undefined)throw new Error('Target host could not be resolved');
  return { url, address };
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}
