import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Check, CircleHelp, Clock3, FilterX, Info, RefreshCw, Search, X } from "lucide-react";
import type { Task, TaskFreshness, TaskSnapshot, TaskSource } from "../shared/tasks";
import { Dialog } from "./Dialog";
import "./tasks.css";

const stateLabels: Record<Task["state"], string> = {
  idle: "等待执行", running: "运行中", succeeded: "上次成功", failed: "上次失败", unknown: "状态未知",
};
const kindLabels: Record<Task["kind"], string> = {
  cron: "Cron", calendar: "日历", interval: "间隔", event: "事件触发", manual: "手动", unknown: "未知日程",
};
const sourceLabels: Record<TaskSource["status"], string> = {
  ok: "已读取", unavailable: "未接入", permission_denied: "权限不足", error: "读取失败", unsupported: "暂不支持",
};
const freshnessLabels: Record<TaskFreshness, string> = {
  fresh: "证据新鲜", stale: "证据已过期", unknown: "证据时间未知",
};
const sourceErrors: Record<NonNullable<TaskSource["error"]>, string> = {
  not_configured: "尚未配置此来源", snapshot_missing: "未找到采集快照", snapshot_unreadable: "无法读取采集快照",
  snapshot_invalid: "采集快照格式无效", snapshot_too_large: "采集快照超出大小限制", permission_denied: "采集权限不足",
  command_unavailable: "采集能力不可用", query_failed: "来源查询失败", query_timeout: "来源查询超时", unsupported: "此来源暂不支持",
};

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function moment(value: string | null, zone: string | null = "UTC"): string {
  if (timestamp(value) === null) return "未提供";
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  };
  try {
    const usedZone = zone || "UTC";
    return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: usedZone }).format(new Date(value!)) + " " + usedZone;
  } catch {
    return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: "UTC" }).format(new Date(value!)) + " UTC（原时区无效）";
  }
}

function duration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "未提供";
  if (value < 1000) return value + " 毫秒";
  if (value < 60_000) return (value / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + " 秒";
  return (value / 60_000).toLocaleString("zh-CN", { maximumFractionDigits: 1 }) + " 分钟";
}

function nextLabel(task: Task): string {
  if (task.enabled === false) return "已停用";
  if (!task.nextRunAt) return task.kind === "manual" ? "手动触发，无固定时间" : task.kind === "event" ? "事件触发，无固定时间" : "未提供";
  return moment(task.nextRunAt, task.timezone);
}

function State({ task }: { task: Task }) {
  return <span className={"nt-state nt-state-" + task.state}>
    {task.state === "succeeded" ? <Check size={13} aria-hidden="true" /> : task.state === "unknown" ? <CircleHelp size={13} aria-hidden="true" /> : <span className="nt-state-dot" />}
    {stateLabels[task.state]}
  </span>;
}

export function Tasks({ snapshot, loading, error, onRefresh, embedded = false }: {
  snapshot: TaskSnapshot | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  embedded?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [serviceFilter, setServiceFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");
  const [sort, setSort] = useState("next");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailOpener = useRef<HTMLButtonElement | null>(null);
  const services = [...new Set((snapshot?.tasks || []).flatMap((task) => task.serviceName ? [task.serviceName] : []))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const sourceMap = useMemo(() => new Map((snapshot?.sources || []).map((source) => [source.id, source])), [snapshot]);
  const matching = useMemo(() => {
    const needle = embedded ? "" : query.trim().toLocaleLowerCase();
    const filtered = (snapshot?.tasks || []).filter((task) => {
      if (embedded) return true;
      const source = sourceMap.get(task.sourceId);
      return (sourceFilter === "all" || task.sourceId === sourceFilter) &&
        (serviceFilter === "all" || task.serviceName === serviceFilter) &&
        (stateFilter === "all" || task.state === stateFilter) &&
        (!needle || [task.name, task.serviceName, source?.name, task.schedule].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle));
    });
    return filtered.sort((left, right) => {
      if (!embedded && sort === "name") return left.name.localeCompare(right.name, "zh-CN");
      const leftTime = timestamp(!embedded && sort === "last" ? left.lastStartedAt : left.enabled === false ? null : left.nextRunAt);
      const rightTime = timestamp(!embedded && sort === "last" ? right.lastStartedAt : right.enabled === false ? null : right.nextRunAt);
      if (leftTime === null && rightTime !== null) return 1;
      if (leftTime !== null && rightTime === null) return -1;
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return !embedded && sort === "last" ? rightTime - leftTime : leftTime - rightTime;
      if ((embedded || sort === "next") && left.nextRunKind !== right.nextRunKind) return left.nextRunKind === "authoritative" ? -1 : right.nextRunKind === "authoritative" ? 1 : 0;
      return left.name.localeCompare(right.name, "zh-CN");
    });
  }, [snapshot, query, sourceFilter, serviceFilter, stateFilter, sort, sourceMap, embedded]);
  const selected = snapshot?.tasks.find((task) => task.id === selectedId);
  const selectedSource = selected ? sourceMap.get(selected.sourceId) : undefined;
  useEffect(() => {
    if (!selected && detailOpener.current) {
      const opener = detailOpener.current;
      detailOpener.current = null;
      if (opener.isConnected) opener.focus();
    }
  }, [selected]);
  const hasFilters = !embedded && Boolean(query || sourceFilter !== "all" || serviceFilter !== "all" || stateFilter !== "all");

  function reset() {
    setQuery(""); setSourceFilter("all"); setServiceFilter("all"); setStateFilter("all");
  }

  return (
    <section className={"nexus-tasks" + (embedded ? " nt-embedded" : "")} aria-label="定时任务" aria-busy={loading}>
      {embedded ? (
        <header className="nt-embedded-head">
          <div className="nt-embedded-title">
            <span className="nt-embedded-slash" aria-hidden="true" />
            <h2>定时任务</h2>
            <div className="nt-embedded-meta">
              {snapshot?.mode === "demo" && <span className="nt-meta-pill">演示数据</span>}
              {snapshot?.mode === "live" && <span className="nt-meta-pill">只读采集</span>}
              {snapshot && <span>{matching.length} 项 · {freshnessLabels[snapshot.freshness]}</span>}
            </div>
          </div>
          <button className="nt-button" onClick={onRefresh} disabled={loading} aria-label="刷新定时任务快照">
            <RefreshCw size={15} className={loading ? "spin" : ""} aria-hidden="true" />{loading ? "读取中…" : "刷新"}
          </button>
        </header>
      ) : (
        <>
          <header className="nt-header">
            <div><h1>任务中心</h1><p>查看各服务的日程与最近执行证据。</p></div>
            <button className="nt-button" onClick={onRefresh} disabled={loading}>
              <RefreshCw size={16} className={loading ? "spin" : ""} aria-hidden="true" />{loading ? "读取中…" : "刷新快照"}
            </button>
          </header>
          {snapshot?.mode === "demo" ? (
            <div className="nt-mode nt-demo"><Info size={18} aria-hidden="true" /><div><strong>演示数据</strong><p>以下为合成任务，用于预览界面；未连接家庭服务，不会执行任何任务。</p></div></div>
          ) : snapshot?.mode === "live" ? (
            <div className="nt-mode"><Clock3 size={18} aria-hidden="true" /><div><strong>只读采集快照</strong><p>这是采集时的状态，不代表持续实时监控。此处仅查看，不运行或修改任务。</p></div></div>
          ) : <div className="nt-mode"><Info size={18} aria-hidden="true" /><div><strong>尚未接入任务来源</strong><p>配置只读采集后可查看日程；未接入不代表没有任务。</p></div></div>}
        </>
      )}

      {error && <div className="nt-error" role="alert"><strong>任务读取失败</strong><p>{error}</p><button className="nt-button" onClick={onRefresh} disabled={loading}>重试读取任务</button></div>}
      {!embedded && snapshot && <div className="nt-observed"><span>{freshnessLabels[snapshot.freshness]}</span><span>快照采集：{moment(snapshot.observedAt)}</span></div>}
      {!embedded && snapshot && snapshot.sources.length > 0 && (
        <section className="nt-sources" aria-labelledby="nt-sources-title">
          <h2 id="nt-sources-title">来源覆盖</h2>
          <ul>{snapshot.sources.map((source) => <li key={source.id}>
            <div><strong>{source.name}</strong><span className={"nt-source-status nt-source-" + source.status}>{sourceLabels[source.status]}</span></div>
            <p>{source.completeness === "complete" ? "已完整读取" : source.completeness === "partial" ? "仅部分可见" : "覆盖范围未知"} · {freshnessLabels[source.freshness]}</p>
            {source.error && <p>{sourceErrors[source.error] || "来源暂不可用"}</p>}
            <small>采集：{moment(source.observedAt)}</small>
          </li>)}</ul>
        </section>
      )}
      {!embedded && (
        <>
          <div className="nt-toolbar">
            <label className="nt-search"><Search size={17} aria-hidden="true" /><span className="sr-only">搜索任务</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、服务或日程" /></label>
            <div className="nt-filter-grid">
              <label>服务<select aria-label="按服务筛选任务" value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}><option value="all">全部服务</option>{services.map((service) => <option key={service} value={service}>{service}</option>)}</select></label>
              <label>来源<select aria-label="按来源筛选任务" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="all">全部来源</option>{(snapshot?.sources || []).map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
              <label>状态<select aria-label="按状态筛选任务" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(stateLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              <label>排序<select aria-label="任务排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="next">下次执行从早到晚</option><option value="last">最近启动优先</option><option value="name">任务名称</option></select></label>
            </div>
          </div>
          <div className="nt-list-heading"><h2>任务日程</h2><span role="status" aria-atomic="true">{loading ? "正在读取任务…" : "显示 " + matching.length + " 项任务"}</span>{hasFilters && <button className="nt-link-button" onClick={reset}><FilterX size={15} aria-hidden="true" />清除筛选</button>}</div>
        </>
      )}

      {!snapshot && loading ? (
        <div className="nt-empty"><Clock3 size={25} aria-hidden="true" /><strong>正在读取任务快照</strong><p>任务状态和来源覆盖会一并显示。</p></div>
      ) : matching.length === 0 ? (
        <div className="nt-empty"><CalendarClock size={27} aria-hidden="true" /><strong>{hasFilters ? "没有匹配的任务" : snapshot?.sources.some((source) => source.status !== "ok") || !snapshot || snapshot.mode === "unconfigured" ? "还没有可展示的任务" : "此快照没有任务"}</strong><p>{hasFilters ? "调整关键词、服务、来源或状态后再试。" : "请结合来源覆盖判断；没有记录不等于所有任务已停止。"}</p>{hasFilters && <button className="nt-button" onClick={reset}>重置任务筛选</button>}</div>
      ) : embedded ? (
        <ol className="nt-home-grid">{matching.map((task) => (
          <li className="nt-home-card" key={task.id}>
            <div className="nt-home-card-top">
              <div>
                <h3>{task.name}</h3>
                <div className="nt-home-sub">
                  <span>{task.serviceName || "未关联服务"} · {sourceMap.get(task.sourceId)?.name || "未知来源"}</span>
                  <span className="nt-cron-badge">{task.schedule || kindLabels[task.kind]}</span>
                </div>
              </div>
              <State task={task} />
            </div>
            <div className="nt-home-card-bottom">
              <dl className="nt-home-facts">
                <div><dt>下次执行</dt><dd>{nextLabel(task)}</dd></div>
                <div><dt>最近启动</dt><dd>{moment(task.lastStartedAt, task.timezone)}</dd></div>
                <div><dt>耗时 / 退出码</dt><dd>{duration(task.durationMs)} / {task.exitCode === null ? "未知" : task.exitCode}</dd></div>
              </dl>
              <button className="nt-detail-button" onClick={(event) => { detailOpener.current = event.currentTarget; setSelectedId(task.id); }} aria-label={"查看任务 " + task.name + " 详情"}>详情</button>
            </div>
          </li>
        ))}</ol>
      ) : (
        <ol className="nt-task-list">{matching.map((task) => <li className="nt-task-row" key={task.id}>
          <div className="nt-task-title"><div><h3>{task.name}</h3><State task={task} /></div><p>{task.serviceName || "未关联服务"} / {sourceMap.get(task.sourceId)?.name || "未知来源"}</p><p className="nt-schedule">{task.schedule || kindLabels[task.kind]} <span>{task.timezone || "任务时区未提供"}</span></p><span className={"nt-freshness nt-freshness-" + task.freshness}>{freshnessLabels[task.freshness]}{task.enabled === false ? " · 已停用" : task.enabled === null ? " · 启用状态未知" : ""}</span></div>
          <dl className="nt-row-facts">
            <div><dt>下次执行</dt><dd>{nextLabel(task)}{task.nextRunAt && task.enabled !== false && <small>{task.nextRunKind === "estimated" ? "估算时间，并非调度器确认" : task.nextRunKind === "authoritative" ? "来源已提供" : "时间依据未知"}</small>}</dd></div>
            <div><dt>最近启动</dt><dd>{moment(task.lastStartedAt, task.timezone)}</dd></div>
            <div><dt>最近耗时 / 退出码</dt><dd>{duration(task.durationMs)} / {task.exitCode === null ? "未知" : task.exitCode}</dd></div>
          </dl>
          <button className="nt-detail-button" onClick={(event) => { detailOpener.current = event.currentTarget; setSelectedId(task.id); }} aria-label={"查看任务 " + task.name + " 详情"}>详情</button>
        </li>)}</ol>
      )}
      {selected && <Dialog label={"任务详情：" + selected.name} className="nt-dialog" onClose={() => setSelectedId(null)}>
        <div className="nt-detail">
          <header><div><p>只读任务详情</p><h2>{selected.name}</h2></div><button className="nt-close" onClick={() => setSelectedId(null)} aria-label="关闭任务详情"><X size={20} aria-hidden="true" /></button></header>
          {snapshot?.mode === "demo" && <p className="nt-detail-demo">演示数据 · 不对应家庭服务</p>}
          <div className="nt-detail-status"><State task={selected} /><span>{freshnessLabels[selected.freshness]}</span></div>
          <dl className="nt-detail-facts">
            <div><dt>服务</dt><dd>{selected.serviceName || "未关联服务"}</dd></div>
            <div><dt>来源</dt><dd>{selectedSource?.name || "未知来源"} · {selectedSource ? sourceLabels[selectedSource.status] : "未接入"}</dd></div>
            <div><dt>日程类型</dt><dd>{kindLabels[selected.kind]}</dd></div>
            <div><dt>日程表达式</dt><dd>{selected.schedule || "未提供"}</dd></div>
            <div><dt>任务时区</dt><dd>{selected.timezone || "未提供；时间按 UTC 展示"}</dd></div>
            <div><dt>是否启用</dt><dd>{selected.enabled === null ? "未知" : selected.enabled ? "已启用" : "已停用"}</dd></div>
            <div><dt>最近启动</dt><dd>{moment(selected.lastStartedAt, selected.timezone)}</dd></div>
            <div><dt>最近结束</dt><dd>{moment(selected.lastFinishedAt, selected.timezone)}</dd></div>
            <div><dt>下次执行</dt><dd>{nextLabel(selected)}<small>{selected.nextRunAt && selected.enabled !== false ? selected.nextRunKind === "estimated" ? "估算时间，并非调度器确认" : selected.nextRunKind === "authoritative" ? "来源已提供" : "时间依据未知" : "不根据历史记录推断下次执行"}</small></dd></div>
            <div><dt>最近耗时</dt><dd>{duration(selected.durationMs)}</dd></div>
            <div><dt>退出码</dt><dd>{selected.exitCode === null ? "未知；不能据此判断成功" : selected.exitCode}</dd></div>
            <div><dt>来源更新时间</dt><dd>{moment(selected.sourceUpdatedAt, selected.timezone)}</dd></div>
            <div><dt>任务采集时间</dt><dd>{moment(selected.observedAt)}</dd></div>
            <div><dt>来源采集时间</dt><dd>{moment(selectedSource?.observedAt || null)}</dd></div>
          </dl>
          <p className="nt-detail-note">状态来自只读采集证据。缺少执行记录、过期证据和未知退出码均不能证明执行成功。</p>
        </div>
      </Dialog>}
    </section>
  );
}
