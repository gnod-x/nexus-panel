import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  FolderPlus,
  Heart,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Star,
  Sun,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { actionError, ApiError, api } from "./api";
import { Dialog } from "./Dialog";
import { ManagementDialog, type ManagementAction } from "./Management";
import type { Group, Service, ServiceEvent, User } from "../server/types";
import "./styles.css";

type Status = Service["status"];
type View = "overview" | "services" | "favorites" | "events" | "settings" | `group:${number}`;

function loadDirectory() {
  return Promise.all([
    api<{ services: Service[] }>("/api/services"),
    api<{ groups: Group[] }>("/api/groups"),
    loadEvents(),
  ]);
}

function loadEvents() {
  return api<{ events: ServiceEvent[] }>("/api/events?limit=50");
}

const statusMeta: Record<Status, { label: string; color: string }> = {
  healthy: { label: "正常", color: "green" },
  degraded: { label: "降级", color: "amber" },
  offline: { label: "离线", color: "red" },
  unknown: { label: "未检查", color: "gray" },
};

function App() {
  const [services, setServices] = useState<Service[]>([]),
    [groups, setGroups] = useState<Group[]>([]),
    [active, setActive] = useState<View>("overview"),
    [query, setQuery] = useState(""),
    [statusFilter, setStatusFilter] = useState<Status | "all">("all"),
    [favorites, setFavorites] = useState<string[]>(() => {
      try {
        const saved = JSON.parse(localStorage.getItem("nexus-favorites") || "[]");
        return Array.isArray(saved) ? saved.filter((value) => typeof value === "string") : [];
      } catch {
        return [];
      }
    }),
    [selected, setSelected] = useState<Service | null>(null),
    [dark, setDark] = useState(true),
    [loading, setLoading] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [menu, setMenu] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [commandOpen, setCommandOpen] = useState(false),
    [managementAction, setManagementAction] = useState<ManagementAction | null>(null),
    [serviceForm, setServiceForm] = useState<Service | false | null>(null);
  const [auth, setAuth] = useState<
    "loading" | "bootstrap" | "login" | "ready" | "error"
  >("loading");
  const [user, setUser] = useState<User | null>(null);
  const canWrite = user?.role === "admin" || user?.role === "operator";
  const canDelete = user?.role === "admin";
  const [authError, setAuthError] = useState("");
  const [events, setEvents] = useState<ServiceEvent[]>([]);
  useEffect(() => {
    const saved = localStorage.getItem("nexus-theme");
    if (saved) setDark(saved === "dark");
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("nexus-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    localStorage.setItem("nexus-favorites", JSON.stringify(favorites));
  }, [favorites]);
  useEffect(() => {
    if (auth !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        setCommandOpen(true);
      }
      if (e.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [auth]);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const st = await api<{ bootstrapped: boolean }>("/api/auth/status");
        if (!st.bootstrapped) {
          if (live) setAuth("bootstrap");
          return;
        }
        try {
          const me = await api<{ user: User }>("/api/auth/me");
          if (live) {
            setUser(me.user);
            setAuth("ready");
          }
        } catch (e) {
          if (!live) return;
          if (e instanceof ApiError && e.status === 401) setAuth("login");
          else {
            setAuth("error");
            setAuthError("认证状态检查失败，请确认服务端正常运行");
          }
        }
      } catch {
        if (live) {
          setAuth("error");
          setAuthError("无法连接服务端，请检查网络后重试");
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (auth !== "ready") return;
    let live = true;
    loadDirectory()
      .then(([s, g, e]) => {
        if (live) {
          setServices(s.services);
          setGroups(g.groups);
          setEvents(e.events);
        }
      })
      .catch(() => {
        if (live) setError("无法读取面板数据，请重新登录");
      });
    return () => {
      live = false;
    };
  }, [auth]);
  const filtered = useMemo(
    () =>
      services.filter(
        (s) =>
          (statusFilter === "all" || s.status === statusFilter) &&
          (!query ||
            `${s.name} ${s.description} ${s.tags.join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase())),
      ),
    [services, query, statusFilter],
  );
  const activeGroup = groups.find((group) => `group:${group.id}` === active);
  const activeServices = useMemo(() => {
    if (active === "services" || (active.startsWith("group:") && !activeGroup)) return filtered;
    if (active === "favorites") return filtered.filter((s) => favorites.includes(s.slug));
    return filtered.filter((s) => s.groupId === activeGroup?.id);
  }, [active, activeGroup, favorites, filtered]);
  const { counts, averageLatency } = useMemo(() => {
    const counts = { total: services.length, healthy: 0, degraded: 0, offline: 0, unknown: 0 };
    let latencyTotal = 0;
    let samples = 0;
    for (const service of services) {
      counts[service.status]++;
      if (service.latencyMs !== null) {
        samples++;
        latencyTotal += service.latencyMs;
      }
    }
    return { counts, averageLatency: samples ? Math.round(latencyTotal / samples) : null };
  }, [services]);
  async function check(s: Service) {
    setLoading(true);
    setError("");
    try {
      const r = await api<{ service: Service }>(`/api/services/${s.id}/check`, {
        method: "POST",
      });
      setServices((xs) => xs.map((x) => (x.id === s.id ? r.service : x)));
      setSelected((current) => current?.id === s.id ? r.service : current);
      const { events } = await loadEvents();
      setEvents(events);
    } catch (cause) {
      setError(actionError(cause, "检查失败，请确认服务地址和网络连接"));
    } finally {
      setLoading(false);
    }
  }
  async function saveService(data: Record<string, unknown>) {
    if (serviceForm === null) return;
    const result = await api<{ service: Service }>(
      serviceForm ? `/api/services/${serviceForm.id}` : "/api/services",
      { method: serviceForm ? "PATCH" : "POST", body: JSON.stringify(data) },
    );
    setServices((current) => serviceForm
      ? current.map((s) => s.id === result.service.id ? result.service : s)
      : [...current, result.service]);
    if (serviceForm && serviceForm.slug !== result.service.slug) {
      setFavorites((current) => current.map((slug) =>
        slug === serviceForm.slug ? result.service.slug : slug));
    }
    setServiceForm(null);
    setSelected(result.service);
    setError("");
  }
  async function deleteService(s: Service) {
    if (!window.confirm(`删除服务“${s.name}”？`)) return;
    try {
      await api(`/api/services/${s.id}`, { method: "DELETE" });
      setServices((xs) => xs.filter((x) => x.id !== s.id));
      setFavorites((current) => current.filter((slug) => slug !== s.slug));
      setSelected(null);
    } catch (cause) {
      setError(actionError(cause, "删除失败，请稍后重试。"));
    }
  }
  async function refreshData() {
    setRefreshing(true);
    try {
      const [s, g, e] = await loadDirectory();
      setServices(s.services);
      setGroups(g.groups);
      setEvents(e.events);
      setActive((current) => current.startsWith("group:") &&
        !g.groups.some((group) => `group:${group.id}` === current) ? "services" : current);
      setError("");
    } catch {
      setError("刷新失败，请确认登录状态和服务连接");
    } finally {
      setRefreshing(false);
    }
  }
  function toggleFavorite(service: Service) {
    setFavorites((current) =>
      current.includes(service.slug)
        ? current.filter((slug) => slug !== service.slug)
        : [...current, service.slug],
    );
  }
  const activeTitle =
    active === "overview"
      ? "总览"
      : active === "services"
        ? "全部服务"
        : active === "favorites"
          ? "收藏服务"
          : active === "events"
            ? "运行事件"
            : active === "settings"
              ? "设置"
              : (activeGroup?.name ?? "全部服务");
  if (auth === "loading")
    return <AuthScreen mode="loading" onSubmit={() => {}} error="" />;
  if (auth === "error")
    return (
      <AuthScreen
        mode="error"
        onSubmit={() => window.location.reload()}
        error={authError}
      />
    );
  if (auth === "bootstrap" || auth === "login")
    return (
      <AuthScreen
        mode={auth}
        error={authError}
        onSubmit={async (data) => {
          setAuthError("");
          try {
            let res: { user: User };
            if (auth === "bootstrap") {
              res = await api("/api/auth/bootstrap", {
                method: "POST",
                body: JSON.stringify(data),
              });
              await api("/api/auth/login", {
                method: "POST",
                body: JSON.stringify(data),
              });
            } else {
              res = await api("/api/auth/login", {
                method: "POST",
                body: JSON.stringify(data),
              });
            }
            setUser(res.user);
            setAuth("ready");
          } catch (cause) {
            if (cause instanceof ApiError && cause.status === 409) {
              setAuth("login");
              setAuthError("已经初始化，请登录");
            } else if (cause instanceof ApiError && cause.status === 429) {
              setAuthError("尝试次数过多，请稍后再试");
            } else {
              setAuthError("邮箱或密码不正确，或密码不符合要求");
            }
          }
        }}
      />
    );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <Zap size={17} />
          </div>
          <span>NEXUS</span>
          <small>CONTROL</small>
        </div>
        <button className="close-nav" aria-label="关闭导航" onClick={() => setMenu(false)}>
          <X size={18} />
        </button>
        <nav>
          <button
            className={active === "overview" ? "active" : ""}
            onClick={() => {
              setActive("overview");
              setMenu(false);
            }}
          >
            <LayoutDashboard size={17} />
            总览
          </button>
          <div className="nav-label">服务目录</div>
          <button
            className={active === "services" ? "active" : ""}
            onClick={() => {
              setActive("services");
              setMenu(false);
            }}
          >
            <CircleDot size={17} />
            全部服务
            <em>{services.length}</em>
          </button>
          <button
            className={active === "favorites" ? "active" : ""}
            onClick={() => {
              setActive("favorites");
              setMenu(false);
            }}
          >
            <Star size={16} />
            收藏服务
            <em>{favorites.length}</em>
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              className={activeGroup?.id === g.id ? "active" : ""}
              onClick={() => {
                setActive(`group:${g.id}`);
                setMenu(false);
              }}
            >
              <span className="group-dot" style={{ background: g.color }} />
              {g.name}
              <em>{services.filter((s) => s.groupId === g.id).length}</em>
            </button>
          ))}
          <div className="nav-label">系统</div>
          {canWrite && (
            <>
              <button
                className="nav-action"
                onClick={() => {
                  setManagementAction({ type: "group" });
                  setMenu(false);
                }}
              >
                <FolderPlus size={17} />
                添加分组
              </button>
              {canDelete && (
                <button
                  className="nav-action"
                  onClick={() => {
                    setManagementAction({ type: "import" });
                    setMenu(false);
                  }}
                >
                  <Upload size={17} />
                  导入数据
                </button>
              )}
            </>
          )}
          <button
            className={active === "events" ? "active" : ""}
            onClick={() => {
              setActive("events");
              setMenu(false);
            }}
          >
            <Activity size={17} />
            运行事件
          </button>
          <button
            className={active === "settings" ? "active" : ""}
            onClick={() => {
              setActive("settings");
              setMenu(false);
            }}
          >
            <Settings size={17} />
            设置
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className="secure">
            <ShieldCheck size={15} />
            <span>已登录</span>
            <i />
          </div>
          <div className="user">
            <div className="avatar">
              {(user?.email || "A").slice(0, 1).toUpperCase()}
            </div>
            <div>
              <strong>{user?.email || "管理员"}</strong>
              <small>{user?.role || "admin"}</small>
            </div>
            <button
              className="logout"
              title="退出登录"
              aria-label="退出登录"
              onClick={async () => {
                try {
                  await api("/api/auth/logout", { method: "POST" });
                } catch (cause) {
                  if (!(cause instanceof ApiError) || cause.status !== 401) {
                    setError("退出失败，请重试");
                    return;
                  }
                }
                setAuth("login");
                setUser(null);
                setServices([]);
                setGroups([]);
                setEvents([]);
                setActive("overview");
                setMenu(false);
                setNotice("");
                setError("");
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <button
            className="menu-btn"
            aria-label="打开导航"
            aria-expanded={menu}
            onClick={() => setMenu(true)}
          >
            <Menu size={20} />
          </button>
          <div className="crumb">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {activeTitle}
            </strong>
          </div>
          <div className="top-actions">
            <button
              className="search-trigger"
              aria-label="搜索服务"
              onClick={() => setCommandOpen(true)}
            >
              <Search size={16} />
              <span>搜索服务...</span>
              <kbd>⌘ K</kbd>
            </button>
            <button
              className="icon-btn"
              onClick={() => setDark(!dark)}
              aria-label="切换主题"
            >
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button
              className="icon-btn"
              aria-label="查看运行事件"
              onClick={() => setActive("events")}
            >
              <BellDot />
            </button>
          </div>
        </header>
        <div className="content">
          <div className="page-head">
            <div>
              <div className="eyebrow">
                SYSTEM OVERVIEW <span>•</span>{" "}
                {new Date().toLocaleDateString("zh-CN", {
                  month: "short",
                  day: "numeric",
                })}
              </div>
              <h1>{active === "overview" ? "运行总览" : activeTitle}</h1>
              <p>
                {active === "overview"
                  ? "所有服务和基础设施的实时状态。"
                  : active === "events"
                    ? "近期健康检查与管理操作记录。"
                    : active === "settings"
                      ? "账户信息与本地显示偏好。"
                      : active === "favorites"
                        ? "快速访问你标记的重要服务。"
                        : "查看并管理已配置的服务。"}
              </p>
            </div>
            <div className="head-actions">
              <button
                className="secondary"
                aria-label="刷新数据"
                onClick={refreshData}
                disabled={refreshing}
              >
                <RefreshCw size={15} className={refreshing ? "spin" : ""} />
                {refreshing ? "刷新中..." : "刷新数据"}
              </button>
              {canWrite && (
                <button
                  className="primary"
                  aria-label="添加服务"
                  onClick={() => setServiceForm(false)}
                >
                  <Plus size={16} />
                  添加服务
                </button>
              )}
            </div>
          </div>
          {error && (
            <div className="toast" role="alert">
              <AlertTriangle size={16} />
              {error}
              <button aria-label="关闭错误提示" onClick={() => setError("")}>
                <X size={14} />
              </button>
            </div>
          )}
          {notice && (
            <div className="toast success" role="status">
              <CheckCircle2 size={16} />
              {notice}
              <button aria-label="关闭提示" onClick={() => setNotice("")}>
                <X size={14} />
              </button>
            </div>
          )}
          {active === "overview" ? (
            <>
              <section className="metrics">
                <Metric
                  label="服务总数"
                  value={counts.total}
                  hint="已配置服务"
                  icon={<CircleDot />}
                  tone="blue"
                />
                <Metric
                  label="运行正常"
                  value={counts.healthy}
                  hint={counts.total === counts.unknown
                    ? "暂无检查结果"
                    : `${Math.round(100 * counts.healthy / (counts.total - counts.unknown))}% 已检查服务正常`}
                  icon={<CheckCircle2 />}
                  tone="green"
                />
                <Metric
                  label="需要关注"
                  value={counts.degraded + counts.offline}
                  hint={`${counts.degraded} 降级 · ${counts.offline} 离线`}
                  icon={<AlertTriangle />}
                  tone="amber"
                />
                <Metric
                  label="平均延迟"
                  value={
                    averageLatency === null
                      ? "—"
                      : `${averageLatency} ms`
                  }
                  hint="各服务最近一次检查"
                  icon={<Activity />}
                  tone="purple"
                />
              </section>
              <section className="grid-main">
                <div className="panel services-panel">
                  <PanelHeader
                    title="服务状态"
                    count={services.length}
                    action="查看全部"
                    onAction={() => setActive("services")}
                  />
                  <div className="service-list">
                    {services.slice(0, 6).map((s) => (
                      <ServiceRow
                        key={s.id}
                        service={s}
                        onClick={() => setSelected(s)}
                      />
                    ))}
                    {services.length === 0 && (
                      <div className="empty-state">
                        <CircleDot />
                        <strong>还没有服务</strong>
                        <span>添加一个服务来开始监控运行状态。</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="panel events-panel">
                  <PanelHeader
                    title="最近事件"
                    action="查看全部"
                    onAction={() => setActive("events")}
                  />
                  <div className="event-list">
                    {events.slice(0, 5).map((e) => (
                      <Event
                        key={e.id}
                        icon={
                          e.type === "health_check" ? (
                            <Activity />
                          ) : (
                            <CheckCircle2 />
                          )
                        }
                        title={e.message}
                        detail={new Date(e.createdAt).toLocaleString("zh-CN")}
                        tone={e.type === "health_check" ? "blue" : "green"}
                      />
                    ))}
                    {events.length === 0 && (
                      <div className="empty-state compact">
                        <Activity />
                        <strong>暂无事件</strong>
                        <span>服务事件会显示在这里。</span>
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </>
          ) : active === "events" ? (
            <section className="panel full-panel">
              <PanelHeader title="运行事件" count={events.length} action="" />
              <div className="event-list">
                {events.map((e) => (
                  <Event
                    key={e.id}
                    icon={<Activity />}
                    title={e.message}
                    detail={new Date(e.createdAt).toLocaleString("zh-CN")}
                    tone="blue"
                  />
                ))}
                {events.length === 0 && (
                  <div className="empty-state">
                    <Activity />
                    <strong>暂无事件</strong>
                    <span>服务事件会显示在这里。</span>
                  </div>
                )}
              </div>
            </section>
          ) : active === "settings" ? (
            <section className="panel full-panel settings-panel">
              <PanelHeader title="设置" action="" />
              <div className="settings-content">
                <div className="setting-row">
                  <div>
                    <strong>当前账户</strong>
                    <span>{user?.email}</span>
                  </div>
                  <span className="setting-value">{user?.role}</span>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>外观主题</strong>
                    <span>选择控制台的显示主题。</span>
                  </div>
                  <button className="secondary" onClick={() => setDark((value) => !value)}>
                    {dark ? "深色模式" : "浅色模式"}
                  </button>
                </div>
                <div className="setting-row">
                  <div>
                    <strong>收藏服务</strong>
                    <span>收藏仅保存在当前浏览器中。</span>
                  </div>
                  <span className="setting-value">{favorites.length}</span>
                </div>
                {canWrite && (
                  <div className="setting-row">
                    <div><strong>服务分组</strong></div>
                    <div className="setting-actions">
                      <button className="secondary" onClick={() => setManagementAction({ type: "group" })}>
                        <FolderPlus size={15} />
                        新建分组
                      </button>
                      {groups.map((group) => (
                        <button
                          key={group.id}
                          className="secondary"
                          onClick={() => setManagementAction({ type: "group", group })}
                        >
                          <span className="group-dot" style={{ background: group.color }} />
                          {group.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className="panel full-panel">
              <PanelHeader
                title={active === "favorites" ? "收藏服务" : "服务列表"}
                count={activeServices.length}
                action=""
              />
              <div className="table-toolbar">
                <div className="search-box">
                  <Search size={16} />
                  <input
                    id="global-search"
                    aria-label="搜索服务目录"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索服务、标签或描述"
                  />
                </div>
                <label className="filter-select">
                  <span className="sr-only">状态筛选</span>
                  <select
                    aria-label="状态筛选"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as Status | "all")}
                  >
                    <option value="all">全部状态</option>
                    <option value="healthy">正常</option>
                    <option value="degraded">降级</option>
                    <option value="offline">离线</option>
                    <option value="unknown">未检查</option>
                  </select>
                </label>
              </div>
              <div className="service-list">
                {activeServices.map((s) => (
                    <ServiceRow
                      key={s.id}
                      service={s}
                      onClick={() => setSelected(s)}
                    />
                ))}
              </div>
              {activeServices.length === 0 && (
                <div className="empty-state">
                  <Heart />
                  <strong>{active === "favorites" ? "还没有收藏服务" : "还没有服务"}</strong>
                  <span>{active === "favorites" ? "在服务详情中收藏常用入口。" : "添加一个服务来开始监控运行状态。"}</span>
                </div>
              )}
            </section>
          )}
        </div>
      </main>
      {selected && (
        <Dialog label={selected.name} className="drawer-dialog" onClose={() => setSelected(null)}>
          <div className="drawer">
            <div className="drawer-head">
              <div>
                <div className="service-icon large">{selected.icon || "SV"}</div>
                <div>
                  <h2>{selected.name}</h2>
                  <p>{selected.description}</p>
                </div>
              </div>
              <button className="icon-btn" aria-label="关闭服务详情" onClick={() => setSelected(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="drawer-status">
              <span
                className={`status-pill ${statusMeta[selected.status].color}`}
              >
                <i />
                {statusMeta[selected.status].label}
              </span>
              <span className="latency">
                {selected.latencyMs === null ? "—" : `${selected.latencyMs} ms`}
              </span>
            </div>
            <div className="drawer-section">
              <h3>服务信息</h3>
              <dl>
                <dt>访问地址</dt>
                <dd>
                  {/^https?:\/\//i.test(selected.url) ? (
                    <a className="service-link" href={selected.url} target="_blank" rel="noopener noreferrer">
                      打开服务 <ArrowUpRight size={13} aria-hidden="true" />
                    </a>
                  ) : "未配置"}
                </dd>
                <dt>最后检查</dt>
                <dd>
                  {selected.lastCheckedAt
                    ? new Date(selected.lastCheckedAt).toLocaleString("zh-CN")
                    : "从未检查"}
                </dd>
                <dt>标签</dt>
                <dd>
                  <div className="tags">
                    {selected.tags.map((t) => (
                      <span key={t}>{t}</span>
                    ))}
                  </div>
                </dd>
              </dl>
            </div>
            <button
              className={`secondary wide favorite-toggle ${favorites.includes(selected.slug) ? "is-favorite" : ""}`}
              aria-label={favorites.includes(selected.slug) ? "取消收藏" : "收藏服务"}
              onClick={() => toggleFavorite(selected)}
            >
              <Star size={15} fill={favorites.includes(selected.slug) ? "currentColor" : "none"} />
              {favorites.includes(selected.slug) ? "已收藏" : "收藏服务"}
            </button>
            {canWrite && (
              <button
                className="primary wide"
                onClick={() => check(selected)}
                disabled={loading}
              >
                <RefreshCw size={15} className={loading ? "spin" : ""} />
                {loading ? "检查中..." : "立即检查"}
              </button>
            )}
            <div className="drawer-actions">
              {canWrite && (
                <button
                  className="secondary"
                  onClick={() => {
                    setServiceForm(selected);
                    setSelected(null);
                  }}
                >
                  编辑
                </button>
              )}
              {canDelete && (
                <button
                  className="danger"
                  onClick={() => deleteService(selected)}
                >
                  删除
                </button>
              )}
            </div>
          </div>
        </Dialog>
      )}
      {serviceForm !== null && (
        <ServiceForm
          service={serviceForm || undefined}
          groups={groups}
          onClose={() => setServiceForm(null)}
          onSave={saveService}
        />
      )}
      {managementAction && (
        <ManagementDialog
          action={managementAction}
          canDelete={canDelete}
          onClose={() => setManagementAction(null)}
          onDone={(message) => {
            setManagementAction(null);
            setNotice(message);
            void refreshData();
          }}
        />
      )}
      {commandOpen && (
        <CommandPalette
          services={services}
          onClose={() => setCommandOpen(false)}
          onOpen={(s) => {
            setSelected(s);
            setCommandOpen(false);
          }}
        />
      )}
    </div>
  );
}
function BellDot() {
  return (
    <span className="bell-dot">
      <Activity size={17} />
      <i />
    </span>
  );
}
function ServiceForm({
  service,
  groups,
  onClose,
  onSave,
}: {
  service?: Service;
  groups: Group[];
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(service?.name || ""),
    [slug, setSlug] = useState(service?.slug || ""),
    [url, setUrl] = useState(service?.url === "#" ? "" : service?.url || ""),
    [description, setDescription] = useState(service?.description || ""),
    [healthUrl, setHealthUrl] = useState(service?.healthUrl || ""),
    [tags, setTags] = useState(service?.tags.join(", ") || ""),
    [groupId, setGroupId] = useState(String(service?.groupId || ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = service ? "编辑服务" : "添加服务";
  return (
    <Dialog label={title} onClose={() => { if (!busy) onClose(); }}>
      <form
        className="modal"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await onSave({
              name, slug, url, description,
              healthUrl: healthUrl.trim() || null,
              groupId: groupId ? Number(groupId) : null,
              tags: [...new Set(tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))],
            });
          } catch (cause) {
            setError(actionError(cause, "保存失败，请稍后重试。"));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-head">
          <div>
            <div className="eyebrow">SERVICE CONFIGURATION</div>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          名称
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          标识符
          <input
            required
            pattern="[a-z0-9\-]+"
            maxLength={96}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
        <label>
          访问地址
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://service.local"
          />
        </label>
        <label>
          健康检查地址（可选）
          <input type="url" value={healthUrl} onChange={(e) => setHealthUrl(e.target.value)} />
        </label>
        <label>
          描述
          <input
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label>
          标签
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="网络, 监控" />
        </label>
        <label>
          分组
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">未分组</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit" disabled={busy}>
            保存服务
          </button>
        </div>
      </form>
    </Dialog>
  );
}
function CommandPalette({
  services,
  onClose,
  onOpen,
}: {
  services: Service[];
  onClose: () => void;
  onOpen: (s: Service) => void;
}) {
  const [q, setQ] = useState("");
  const rows = services
    .filter((s) =>
      `${s.name} ${s.description} ${s.tags.join(" ")}`
        .toLowerCase()
        .includes(q.toLowerCase()),
    )
    .slice(0, 8);
  return (
    <Dialog label="搜索服务" className="command-dialog" onClose={onClose}>
      <div className="command-palette">
        <div className="command-input">
          <Search size={17} />
          <input
            autoFocus
            aria-label="服务搜索关键词"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索服务..."
          />
          <button type="button" className="icon-btn" aria-label="关闭搜索" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="command-results">
          {rows.map((s) => (
            <button key={s.id} onClick={() => onOpen(s)}>
              <div className="service-icon">{s.icon || "SV"}</div>
              <div>
                <strong>{s.name}</strong>
                <span>{s.description}</span>
              </div>
              <ChevronRight size={15} />
            </button>
          ))}
          {rows.length === 0 && (
            <div className="command-empty">没有匹配的服务</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
function AuthScreen({
  mode,
  onSubmit,
  error,
}: {
  mode: "loading" | "error" | "login" | "bootstrap";
  onSubmit: (data: { email?: string; password?: string }) => void;
  error: string;
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState("");
  if (mode === "loading")
    return (
      <div className="auth-page">
        <div className="auth-box">
          <div className="brand-mark">
            <Zap size={17} />
          </div>
          <p>正在检查面板状态…</p>
        </div>
      </div>
    );
  const setup = mode === "bootstrap";
  return (
    <div className="auth-page">
      <form
        className="auth-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "error") {
            onSubmit({});
            return;
          }
          onSubmit({ email, password });
        }}
      >
        <div className="auth-brand">
          <div className="brand-mark">
            <Zap size={17} />
          </div>
          <span>
            NEXUS <small>CONTROL</small>
          </span>
        </div>
        <div className="eyebrow">
          {mode === "error"
            ? "CONNECTION ERROR"
            : setup
              ? "FIRST-TIME SETUP"
              : "SECURE ACCESS"}
        </div>
        <h1>
          {mode === "error"
            ? "面板暂不可用"
            : setup
              ? "创建管理员"
              : "登录面板"}
        </h1>
        <p>
          {mode === "error"
            ? "无法连接 API 服务。检查服务器状态后重试。"
            : setup
              ? "首次启动需要创建管理员账户。"
              : "使用管理员账户访问服务控制台。"}
        </p>
        {mode !== "error" && (
          <>
            <label>
              邮箱
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@example.com"
              />
            </label>
            <label>
              密码
              <input
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                minLength={setup ? 12 : 1}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={setup ? "至少 12 个字符" : "输入密码"}
              />
            </label>
          </>
        )}
        {error && (
          <div className="auth-error">
            <AlertTriangle size={15} />
            {error}
          </div>
        )}
        <button className="primary auth-submit" type="submit">
          {mode === "error" ? "重新连接" : setup ? "创建管理员" : "登录"}
        </button>
        <div className="auth-foot">
          <ShieldCheck size={14} />
          本地认证 · HTTP-only 会话
        </div>
      </form>
    </div>
  );
}
function Metric({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: React.ReactNode;
  tone: string;
}) {
  return (
    <div className="metric">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{hint}</small>
      </div>
    </div>
  );
}
function PanelHeader({
  title,
  count,
  action,
  onAction,
}: {
  title: string;
  count?: number;
  action: string;
  onAction?: () => void;
}) {
  return (
    <div className="panel-head">
      <div>
        <h2>
          {title}
          {count !== undefined && <span>{count}</span>}
        </h2>
      </div>
      {action && (
        <button className="text-btn" onClick={onAction}>
          {action}
          <ArrowUpRight size={14} />
        </button>
      )}
    </div>
  );
}
function ServiceRow({
  service,
  onClick,
}: {
  service: Service;
  onClick: () => void;
}) {
  const m = statusMeta[service.status];
  return (
    <button className="service-row" onClick={onClick}>
      <div className="service-icon">{service.icon || "SV"}</div>
      <div className="service-info">
        <strong>{service.name}</strong>
        <span>{service.description}</span>
      </div>
      <div className="row-tags">
        {service.tags.slice(0, 2).map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
      <div className="row-health">
        <span className={`status-pill ${m.color}`}>
          <i />
          {m.label}
        </span>
        <small>{service.latencyMs === null ? "—" : `${service.latencyMs} ms`}</small>
      </div>
      <ChevronRight size={16} className="row-chevron" />
    </button>
  );
}
function Event({
  icon,
  title,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  tone: string;
}) {
  return (
    <div className="event">
      <div className={`event-icon ${tone}`}>{icon}</div>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
