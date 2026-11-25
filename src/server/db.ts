import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Group, Service, ServiceEvent, User, Role } from './types.js';

export class Store {
  readonly db: Database.Database;
  constructor(filename = process.env.DATABASE_PATH || './data/nexus.db') {
    if (filename !== ':memory:' && !filename.startsWith('file:')) fs.mkdirSync(path.dirname(path.resolve(filename)),{recursive:true});
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    const migrations: Array<() => void> = [
      () => this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, color TEXT NOT NULL DEFAULT '#3b82f6', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY, group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, health_url TEXT, icon TEXT, tags TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'unknown', latency_ms INTEGER, last_checked_at TEXT, enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, service_id INTEGER REFERENCES services(id) ON DELETE SET NULL, type TEXT NOT NULL, message TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_services_group_id ON services(group_id);
      `),
    ];
    const current = Number(this.db.pragma('user_version', { simple: true }));
    if (!Number.isInteger(current) || current < 0 || current > migrations.length) {
      throw new Error(`Unsupported database schema version: ${current}`);
    }
    if (current === migrations.length) return;
    this.db.transaction(() => {
      for (let version = current; version < migrations.length; version += 1) {
        migrations[version]!();
        this.db.pragma(`user_version = ${version + 1}`);
      }
    }).immediate();
  }

  transactionImmediate<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  now() { return new Date().toISOString(); }
  userCount() { return (this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count; }
  overview() {
    const rows = this.db.prepare('SELECT status,COUNT(*) AS count FROM services GROUP BY status').all() as {status:string;count:number}[];
    const map = Object.fromEntries(rows.map(row => [row.status, row.count]));
    const latency = this.db.prepare('SELECT AVG(latency_ms) AS average FROM services WHERE latency_ms IS NOT NULL').get() as {average:number|null};
    const checked = this.db.prepare('SELECT MAX(last_checked_at) AS checkedAt FROM services').get() as {checkedAt:string|null};
    return { counts:{total:this.listServices().length,healthy:map.healthy||0,degraded:map.degraded||0,offline:map.offline||0,unknown:map.unknown||0}, averageLatencyMs:latency.average===null?null:Math.round(latency.average), checkedAt:checked.checkedAt, recentEvents:this.listEvents(8) };
  }
  createUser(email: string, passwordHash: string, role: Role = 'admin'): User { const now = this.now(); const r = this.db.prepare('INSERT INTO users(email,password_hash,role,created_at) VALUES(?,?,?,?)').run(email, passwordHash, role, now); return { id: Number(r.lastInsertRowid), email, role, createdAt: now }; }
  getUserByEmail(email: string) { const user=this.db.prepare('SELECT id,email,password_hash as passwordHash,role,created_at as createdAt FROM users WHERE lower(email)=lower(?)').get(email) as (User & { passwordHash: string }) | undefined;return user&&['admin','operator','viewer'].includes(user.role)?user:undefined; }
  getUser(id: number) { const user=this.db.prepare('SELECT id,email,role,created_at as createdAt FROM users WHERE id=?').get(id) as User | undefined;return user&&['admin','operator','viewer'].includes(user.role)?user:undefined; }
  saveSession(hash: string, userId: number, expiresAt: string) { this.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hash, userId, expiresAt, this.now()); }
  getSession(hash: string) { return this.db.prepare('SELECT user_id as userId,expires_at as expiresAt FROM sessions WHERE token_hash=?').get(hash) as { userId: number; expiresAt: string } | undefined; }
  deleteSession(hash: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash); }
  purgeSessions() { this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(this.now()); }

  listGroups(): Group[] { return this.db.prepare('SELECT id,name,slug,color,sort_order as sortOrder,created_at as createdAt FROM groups ORDER BY sort_order,name').all() as Group[]; }
  getGroup(id: number): Group | undefined { return this.db.prepare('SELECT id,name,slug,color,sort_order as sortOrder,created_at as createdAt FROM groups WHERE id=?').get(id) as Group | undefined; }
  createGroup(input: { name: string; slug: string; color?: string }) { const now = this.now(); const r = this.db.prepare('INSERT INTO groups(name,slug,color,created_at) VALUES(?,?,?,?)').run(input.name, input.slug, input.color || '#3b82f6', now); return this.db.prepare('SELECT id,name,slug,color,sort_order as sortOrder,created_at as createdAt FROM groups WHERE id=?').get(r.lastInsertRowid) as Group; }
  updateGroup(id: number, input: Partial<{ name: string; slug: string; color: string; sortOrder: number }>) { const fields: string[] = []; const values: unknown[] = []; for (const [key, val] of Object.entries(input)) { const col = key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`); fields.push(`${col}=?`); values.push(val); } if (!fields.length) return this.listGroups().find(g => g.id === id); values.push(id); this.db.prepare(`UPDATE groups SET ${fields.join(',')} WHERE id=?`).run(...values); return this.db.prepare('SELECT id,name,slug,color,sort_order as sortOrder,created_at as createdAt FROM groups WHERE id=?').get(id) as Group | undefined; }
  deleteGroup(id: number) { this.db.prepare('DELETE FROM groups WHERE id=?').run(id); }

  private serviceRow(row: any): Service { return { ...row, enabled: Boolean(row.enabled), tags: JSON.parse(row.tags || '[]') }; }
  listServices() { return (this.db.prepare('SELECT id,group_id as groupId,name,slug,description,url,health_url as healthUrl,icon,tags,status,latency_ms as latencyMs,last_checked_at as lastCheckedAt,enabled,sort_order as sortOrder,created_at as createdAt,updated_at as updatedAt FROM services ORDER BY sort_order,name').all() as any[]).map(row => this.serviceRow(row)); }
  getService(id: number) { const row = this.db.prepare('SELECT id,group_id as groupId,name,slug,description,url,health_url as healthUrl,icon,tags,status,latency_ms as latencyMs,last_checked_at as lastCheckedAt,enabled,sort_order as sortOrder,created_at as createdAt,updated_at as updatedAt FROM services WHERE id=?').get(id); return row ? this.serviceRow(row) : undefined; }
  createService(input: any) { const now = this.now(); const r = this.db.prepare('INSERT INTO services(group_id,name,slug,description,url,health_url,icon,tags,enabled,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(input.groupId ?? null,input.name,input.slug,input.description || '',input.url,input.healthUrl || null,input.icon || null,JSON.stringify(input.tags || []),input.enabled === false ? 0 : 1,input.sortOrder || 0,now,now); return this.getService(Number(r.lastInsertRowid))!; }
  updateService(id: number, input: any) { const map: Record<string,string> = { groupId:'group_id', name:'name', slug:'slug', description:'description', url:'url', healthUrl:'health_url', icon:'icon', tags:'tags', enabled:'enabled', sortOrder:'sort_order', status:'status', latencyMs:'latency_ms', lastCheckedAt:'last_checked_at' }; const fields:string[]=[]; const vals:unknown[]=[]; for (const [key,val] of Object.entries(input)) { if (!(key in map)) continue; fields.push(`${map[key]}=?`); vals.push(key==='tags'?JSON.stringify(val):key==='enabled'?(val?1:0):val); } if (fields.length) { fields.push('updated_at=?'); vals.push(this.now(),id); this.db.prepare(`UPDATE services SET ${fields.join(',')} WHERE id=?`).run(...vals); } return this.getService(id); }
  deleteService(id: number) { this.db.prepare('DELETE FROM services WHERE id=?').run(id); }
  addEvent(serviceId: number | null, type: string, message: string, metadata: Record<string,unknown> = {}) { const r=this.db.prepare('INSERT INTO events(service_id,type,message,metadata,created_at) VALUES(?,?,?,?,?)').run(serviceId,type,message,JSON.stringify(metadata),this.now()); return this.getEvent(Number(r.lastInsertRowid)); }
  getEvent(id:number): ServiceEvent | undefined { const row=this.db.prepare('SELECT id,service_id as serviceId,type,message,metadata,created_at as createdAt FROM events WHERE id=?').get(id) as any; return row ? {...row,metadata:JSON.parse(row.metadata||'{}')} : undefined; }
  listEvents(limit=50) {
    const requested=Number(limit);
    const bounded=Number.isNaN(requested)?50:Math.min(Math.max(Math.trunc(requested),1),200);
    return (this.db.prepare('SELECT id,service_id as serviceId,type,message,metadata,created_at as createdAt FROM events ORDER BY id DESC LIMIT ?').all(bounded) as any[]).map(row=>({...row,metadata:JSON.parse(row.metadata||'{}')}));
  }
}
