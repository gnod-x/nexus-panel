export type IntegrationKind = "cfspeed" | "quark-vod";
export type IntegrationError = "config_invalid" | "permission_denied" | "unavailable" | "unsupported_data" | "timeout" | "response_too_large" | "target_blocked" | null;
export interface IntegrationMetric { key: string; label: string; value: number | string; unit?: string }
export interface IntegrationConnection {
  id: string; name: string; kind: IntegrationKind;
  status: "connected" | "unconfigured" | "error" | "demo";
  serviceSlug: string | null; observedAt: string | null; checkedAt: string | null;
  sourceUpdatedAt: string | null; freshness: "fresh" | "stale" | "unknown";
  metrics: IntegrationMetric[]; errorCode: IntegrationError;
}
export interface IntegrationCatalogEntry { kind: IntegrationKind; name: string; summary: string; authentication: "none" | "bearer-file" }
export interface IntegrationSnapshot {
  version: 1; mode: "demo" | "live" | "unconfigured"; observedAt: string;
  connections: IntegrationConnection[]; available: IntegrationCatalogEntry[];
}
