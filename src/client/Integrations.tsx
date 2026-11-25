import { Activity, ArrowUpRight, CircleHelp, Clock3, Info, Link2, RefreshCw, ShieldCheck } from "lucide-react";
import type { IntegrationConnection, IntegrationError, IntegrationKind, IntegrationSnapshot } from "../shared/integrations";
import "./integrations.css";

type Props = { snapshot: IntegrationSnapshot | null; loading: boolean; error: string; onRefresh: () => void; onOpenService?: (slug: string) => void };
const adapters: Record<IntegrationKind, { name: string; description: string; authentication: string }> = {
  cfspeed: { name: "CFSpeed", description: "读取测速任务与最近结果中的公开汇总指标。", authentication: "只读接口；鉴权由服务端配置。" },
  "quark-vod": { name: "Quark-VOD", description: "读取媒体与任务的汇总状态。", authentication: "只读接口；鉴权由服务端配置。" },
};
const errors: Record<Exclude<IntegrationError, null>, string> = {
  config_invalid: "接入配置无效，请由管理员检查服务端配置。",
  permission_denied: "上游拒绝访问，请由管理员检查读取权限。",
  unavailable: "上游服务暂时无法访问。",
  unsupported_data: "上游返回的格式暂不支持，未读取新指标。",
  timeout: "上游响应超时，请稍后重试。",
  response_too_large: "上游响应超出安全大小限制，未读取新指标。",
  target_blocked: "接入目标未通过安全检查，请由管理员检查配置。",
};
function time(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "暂无记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).format(new Date(value)) + "（浏览器时区）";
}
function status(connection: IntegrationConnection, demo: boolean) {
  if (demo || connection.status === "demo") return "演示数据";
  if (connection.status === "unconfigured") return "未配置";
  if (connection.status === "error") return "读取失败";
  return connection.freshness === "stale" ? "指标已过期" : "已连接";
}
export function Integrations({ snapshot, loading, error, onRefresh, onOpenService }: Props) {
  const demo = snapshot?.mode === "demo";
  const modeTitle = demo ? "演示模式 · 非家庭实时状态" : snapshot?.mode === "live" ? "真实接入 · 只读指标" : snapshot?.mode === "unconfigured" ? "尚未配置真实接入" : error ? "数据来源暂不可确认" : loading ? "正在确认数据来源" : "尚未读取接入状态";
  const connections = snapshot?.connections.filter(item => Object.hasOwn(adapters, item.kind)) ?? [];
  return <section className="ni-integrations" aria-labelledby="ni-title" aria-busy={loading}>
    <header className="ni-header"><div><h1 id="ni-title">服务接入</h1><p>把服务里的关键信息，带回工作台。</p></div><button className="ni-button" onClick={onRefresh} disabled={loading}><RefreshCw size={16} aria-hidden="true" />{loading ? "读取中…" : "刷新接入"}</button></header>
    <div className={`ni-source${demo ? " ni-source-demo" : ""}`} role="note"><Info size={19} aria-hidden="true" /><div><strong>{modeTitle}</strong><p>{demo ? "以下是合成示例，仅用于预览界面，不代表你的家庭服务已接入或正在运行。" : snapshot?.mode === "live" ? "只展示服务端允许读取的汇总指标，不执行扫描、切换或运行操作。" : snapshot?.mode === "unconfigured" ? "适配器已提供，但尚未连接家庭服务。请由管理员在服务端配置只读接入。" : "确认来源后再显示接入状态。"}</p></div></div>
    {error && <div className="ni-error" role="alert"><strong>无法读取服务接入信息</strong><p>请稍后重试。已有数据仅供参考，当前无法确认是否仍然有效。</p><button className="ni-button" onClick={onRefresh} disabled={loading}>重新读取</button></div>}
    {!snapshot && !error && <div className="ni-empty" role="status"><Link2 size={28} aria-hidden="true" /><strong>{loading ? "正在读取接入状态" : "暂无接入信息"}</strong><p>{loading ? "正在确认已配置的只读服务。" : "刷新以查看当前服务的接入状态。"}</p></div>}
    {snapshot && <><div className="ni-section-heading"><h2>接入状态</h2><span>快照时间 {time(snapshot.observedAt)}</span></div>
      {connections.length ? <div className="ni-connections">{connections.map(connection => {
        const adapter = adapters[connection.kind];
        const displayName = connection.name.trim() || adapter.name;
        const isDemo = demo || connection.status === "demo";
        const stale = connection.freshness === "stale" || Boolean(error);
        const metrics = connection.status === "unconfigured" ? [] : connection.metrics;
        return <article className="ni-connection" key={connection.id} aria-label={`${displayName} 接入`}>
          <header><span className="ni-adapter-mark" aria-hidden="true">{connection.kind === "cfspeed" ? <Activity size={23} /> : <Link2 size={23} />}</span><div><h3>{displayName}</h3>{displayName !== adapter.name && <span className="ni-adapter-kind">{adapter.name} · 只读适配器</span>}<span className={`ni-state ni-state-${isDemo ? "demo" : stale ? "stale" : connection.status}`}>{error && !isDemo && connection.status === "connected" ? "状态待确认" : status(connection, isDemo)}</span></div>{connection.serviceSlug && onOpenService && <button className="ni-open" onClick={() => onOpenService(connection.serviceSlug!)} aria-label={`查看 ${displayName} 服务详情`}><ArrowUpRight size={19} aria-hidden="true" /></button>}</header>
          {connection.status === "unconfigured" ? <p className="ni-connection-note">尚未配置真实接入。支持此适配器，并不表示服务已连接。</p> : connection.errorCode ? <p className="ni-connection-note ni-warning" role="status">{errors[connection.errorCode] ?? "读取失败，请稍后重试。"}</p> : connection.status === "error" ? <p className="ni-connection-note ni-warning">读取失败，请稍后重试。</p> : null}
          {isDemo && <p className="ni-metric-note">示例指标 · 非家庭实时数据</p>}
          {!isDemo && metrics.length > 0 && <p className={`ni-metric-note${stale ? " ni-warning" : ""}`}><Clock3 size={14} aria-hidden="true" />{stale ? "上次有效指标 · 已过期，不能代表当前状态" : connection.freshness === "unknown" ? "数据时效未知，不能确认当前状态" : "最近成功读取的指标"}</p>}
          {metrics.length > 0 ? <dl className="ni-metrics">{metrics.map(metric => <div key={metric.key}><dt>{metric.label}</dt><dd>{typeof metric.value === "number" ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(metric.value) : metric.value}{metric.unit && <span>{metric.unit}</span>}</dd></div>)}</dl> : connection.status !== "unconfigured" && <p className="ni-no-metrics">暂无有效指标，等待成功读取。</p>}
          <footer><span>最近检查 <time dateTime={connection.checkedAt ?? undefined}>{time(connection.checkedAt)}</time></span><span>成功读取 <time dateTime={connection.observedAt ?? undefined}>{time(connection.observedAt)}</time></span>{connection.sourceUpdatedAt && <span>上游更新 <time dateTime={connection.sourceUpdatedAt}>{time(connection.sourceUpdatedAt)}</time></span>}</footer>
        </article>;
      })}</div> : <div className="ni-empty"><Link2 size={28} aria-hidden="true" /><strong>尚无已配置的接入</strong><p>下方列出可用适配器，配置成功后才会显示真实指标。</p></div>}
      <details className="ni-catalog"><summary><CircleHelp size={17} aria-hidden="true" />可用的只读适配器<span>2 种</span></summary><p>这里说明已支持的能力，不代表已经连接或通过验证。</p><div>{Object.entries(adapters).map(([kind, adapter]) => <section key={kind}><h3>{adapter.name}</h3><p>{adapter.description}</p><span><ShieldCheck size={14} aria-hidden="true" />{adapter.authentication}</span></section>)}</div></details>
    </>}
  </section>;
}
