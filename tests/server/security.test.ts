import { afterEach, describe, expect, it } from 'vitest';
import { healthTimeoutMs } from '../../src/server/health.js';
import { hashPassword, isPrivateIp, resolveTarget, validateTargetUrl, verifyPassword } from '../../src/server/security.js';

const previousAllowed=process.env.HEALTH_ALLOWED_CIDRS;
afterEach(()=>{if(previousAllowed===undefined)delete process.env.HEALTH_ALLOWED_CIDRS;else process.env.HEALTH_ALLOWED_CIDRS=previousAllowed;});

describe('server security',()=>{
  it('clamps the configurable health timeout',()=>{expect(healthTimeoutMs('250')).toBe(500);expect(healthTimeoutMs('8000')).toBe(8000);expect(healthTimeoutMs('99999')).toBe(15000);expect(healthTimeoutMs('invalid')).toBe(5000);});
  it('hashes passwords and safely rejects invalid hashes',()=>{const encoded=hashPassword('a sufficiently long passphrase');expect(verifyPassword('a sufficiently long passphrase',encoded)).toBe(true);expect(verifyPassword('wrong passphrase',encoded)).toBe(false);expect(verifyPassword('x','bad')).toBe(false);});
  it('classifies private and special IP ranges',()=>{expect(isPrivateIp('10.2.3.4')).toBe(true);expect(isPrivateIp('100.64.0.1')).toBe(true);expect(isPrivateIp('169.254.1.1')).toBe(true);expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);});
  it('denies loopback and link-local by default, and metadata even in allowed networks',async()=>{delete process.env.HEALTH_ALLOWED_CIDRS;await expect(validateTargetUrl('http://127.0.0.1:8080')).rejects.toThrow();await expect(validateTargetUrl('http://169.254.1.1')).rejects.toThrow();process.env.HEALTH_ALLOWED_CIDRS='0.0.0.0/0,::/0';for(const ip of ['169.254.169.254','169.254.170.2','100.100.100.200','[fd00:ec2::254]'])await expect(validateTargetUrl(`http://${ip}`)).rejects.toThrow();await expect(validateTargetUrl('http://metadata.google.internal')).rejects.toThrow();});
  it('allows private health targets only inside explicitly configured CIDRs',async()=>{process.env.HEALTH_ALLOWED_CIDRS='192.168.101.0/24';await expect(validateTargetUrl('http://192.168.101.1:8123')).resolves.toBeInstanceOf(URL);await expect(validateTargetUrl('http://10.0.0.1')).rejects.toThrow();});
  it('rejects credentials and non-http schemes',async()=>{await expect(validateTargetUrl('http://user:pass@example.com')).rejects.toThrow();await expect(validateTargetUrl('file:///etc/passwd')).rejects.toThrow();});
  it('rejects translated addresses and absolute metadata names without a network request',async()=>{
    process.env.HEALTH_ALLOWED_CIDRS='::/0,0.0.0.0/0';
    for(const target of ['http://[64:ff9b::a9fe:a9fe]','http://[64:ff9b:1::a9fe:a9fe]','http://[::ffff:169.254.169.254]','http://metadata.google.internal.']){
      await expect(resolveTarget(target)).rejects.toThrow();
    }
  });
  it('pins a literal destination address for a health check without network access',async()=>{const resolved=await resolveTarget('https://1.1.1.1/health');expect(resolved.url.hostname).toBe('1.1.1.1');expect(resolved.address).toBe('1.1.1.1');});
});
