export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: number;
  email: string;
  role: Role;
  createdAt: string;
}

export interface Group {
  id: number;
  name: string;
  slug: string;
  color: string;
  sortOrder: number;
  createdAt: string;
}

export interface Service {
  id: number;
  groupId: number | null;
  name: string;
  slug: string;
  description: string;
  url: string;
  healthUrl: string | null;
  icon: string | null;
  tags: string[];
  status: 'unknown' | 'healthy' | 'degraded' | 'offline';
  latencyMs: number | null;
  lastCheckedAt: string | null;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceEvent {
  id: number;
  serviceId: number | null;
  type: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
