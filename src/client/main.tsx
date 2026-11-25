import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  CalendarClock,
  Plug2,
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
  Orbit,
} from "lucide-react";
import { actionError, ApiError, api } from "./api";
import "./styles.css";
import { AuthScreen } from "./AuthScreen";
import { Home } from "./Home";
import { Tasks } from "./Tasks";
import { Integrations } from "./Integrations";
import type { TaskSnapshot } from "../shared/tasks";
import type { IntegrationSnapshot } from "../shared/integrations";
import { HOME_FONTS, HOME_FONT_IDS, type HomeFontId } from "../shared/home-fonts";
import { Dialog } from "./Dialog";
import { ManagementDialog, type ManagementAction } from "./Management";
import type { Group, Service, ServiceEvent, User } from "../server/types";

type Status = Service["status"];
type View = "overview" | "services" | "favorites" | "tasks" | "integrations" | "events" | "settings" | "groups" | `group:${number}`;

const viewPaths: Record<string, string> = {
  overview: "#/", tasks: "#/manage/tasks", services: "#/manage/services",
  favorites: "#/manage/favorites", groups: "#/manage/groups",
  integrations: "#/manage/integrations", events: "#/manage/events", settings: "#/manage/settings",
};
function routeView(): View {
  const hash = window.location.hash;
  const match = Object.entries(viewPaths).find(([, path]) => path === hash);
  if (match) return match[0] as View;
  const group = /^#\/manage\/groups\/([1-9]\d*)$/.exec(hash)?.[1];
  return group && Number.isSafeInteger(Number(group)) ? ("group:" + group) as View : "overview";
}
function viewPath(view: View): string {
  return view.startsWith("group:") ? "#/manage/groups/" + view.slice(6) : viewPaths[view] ?? "#/";
}

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

function readPreference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writePreference(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Optional persistence must not block the session. */ }
}

function App() {
  const [services, setServices] = useState<Service[]>([]),
    [groups, setGroups] = useState<Group[]>([]),
    [active, setActive] = useState<View>(routeView),
    [query, setQuery] = useState(""),
    [statusFilter, setStatusFilter] = useState<Status | "all">("all"),
    [favorites, setFavorites] = useState<string[]>(() => {
      try {
        const saved = JSON.parse(readPreference("nexus-favorites") || "[]");
        return Array.isArray(saved) ? saved.filter((value) => typeof value === "string") : [];
      } catch {
        return [];
      }
    }),
    [selected, setSelected] = useState<Service | null>(null),
    [dark, setDark] = useState(() => readPreference("nexus-theme") !== "light"),
    [homeFont, setHomeFont] = useState<HomeFontId>("calligraphy"),
    [homeFontDraft, setHomeFontDraft] = useState<HomeFontId>("calligraphy"),
    [homeFontStatus, setHomeFontStatus] = useState(""),
    [homeFontLoading, setHomeFontLoading] = useState(false),
    [homeFontSaving, setHomeFontSaving] = useState(false),
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
  const inManagement = active !== "overview";
  const [wideNavigation, setWideNavigation] = useState(() => window.matchMedia("(min-width: 901px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 901px)");
    const update = () => { setWideNavigation(media.matches); setMenu(false); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const update = () => setActive(routeView());
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  useEffect(() => {
    const path = viewPath(active);
    if (window.location.hash !== path) window.history.pushState(null, "", path);
    setMenu(false);
    window.scrollTo({ top: 0, behavior: "instant" });
    document.title = inManagement ? "Nexus · 管理" : "Nexus · 工作台";
  }, [active, inManagement]);
  const [authError, setAuthError] = useState("");
  const [usernameLogin, setUsernameLogin] = useState(false);
  const [events, setEvents] = useState<ServiceEvent[]>([]);
  const [directoryState, setDirectoryState] = useState<"loading" | "ready" | "error">("loading");
  const [loggingOut, setLoggingOut] = useState(false);
  const logoutPending = useRef(false);
  const [taskSnapshot, setTaskSnapshot] = useState<TaskSnapshot | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [integrationSnapshot, setIntegrationSnapshot] = useState<IntegrationSnapshot | null>(null);
  const [integrationLoading, setIntegrationLoading] = useState(false);
  const [integrationError, setIntegrationError] = useState("");
  const dataGeneration = useRef(0);
  const taskRequest = useRef(0);
  const integrationRequest = useRef(0);
  const homeFontRequest = useRef(0);
  const directoryRequest = useRef(0);
  const checkRequest = useRef(0);
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (auth !== "ready") return;
    const frame = requestAnimationFrame(() => {
      if (document.querySelector("dialog[open]")) return;
      const target = mainRef.current?.querySelector<HTMLElement>("h1") || mainRef.current;
      if (target) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, auth]);
  useEffect(() => {
    if (!menu || !inManagement || wideNavigation) return;
    const mobile = window.matchMedia("(max-width: 900px)");
    const nav = navRef.current;
    const main = mainRef.current;
    if (!nav || !main) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    const wasInert = main.inert;
    main.inert = true;
    document.body.style.overflow = "hidden";
    const controls = () => [...nav.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],[tabindex='0']")]
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    let frame = 0;
    let focusAttempts = 0;
    const focusNavigation = () => {
      if (nav.contains(document.activeElement)) return;
      controls()[0]?.focus();
      if (!nav.contains(document.activeElement) && focusAttempts++ < 20) frame = requestAnimationFrame(focusNavigation);
    };
    // Visibility may still be at the hidden end of the CSS transition.
    frame = requestAnimationFrame(focusNavigation);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMenu(false); return; }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0], last = items[items.length - 1];
      if (!first || !last) { event.preventDefault(); return; }
      if (!nav.contains(document.activeElement)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    const onResize = () => setMenu(false);
    document.addEventListener("keydown", onKey);
    mobile.addEventListener("change", onResize);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      mobile.removeEventListener("change", onResize);
      main.inert = wasInert;
      document.body.style.overflow = overflow;
      if (opener?.isConnected && !document.querySelector("dialog[open]")) opener.focus();
    };
  }, [menu, inManagement, wideNavigation]);
  function activateSession(nextUser: User) {
    dataGeneration.current += 1;
    setUser(nextUser);
    setAuth("ready");
  }
  async function refreshTasks(generation = dataGeneration.current) {
    const request = ++taskRequest.current;
    setTaskLoading(true);
    setTaskError("");
    try {
      const result = await api<{ snapshot: TaskSnapshot }>("/api/tasks");
      if (dataGeneration.current === generation && taskRequest.current === request) setTaskSnapshot(result.snapshot);
    } catch {
      if (dataGeneration.current === generation && taskRequest.current === request) setTaskError("无法读取任务快照，请稍后重试。");
    } finally {
      if (dataGeneration.current === generation && taskRequest.current === request) setTaskLoading(false);
    }
  }
  async function saveHomeFont() {
    if (user?.role !== "admin" || homeFontSaving) return;
    const generation = dataGeneration.current;
    setHomeFontSaving(true);
    setHomeFontStatus("");
    try {
      const result = await api<{ homeFont: HomeFontId }>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ homeFont: homeFontDraft }),
      });
      if (dataGeneration.current !== generation) return;
      setHomeFont(result.homeFont);
      setHomeFontDraft(result.homeFont);
      setHomeFontStatus("首页字体已保存。");
    } catch {
      if (dataGeneration.current === generation) setHomeFontStatus("保存失败，请检查会话后重试。");
    } finally {
      if (dataGeneration.current === generation) setHomeFontSaving(false);
    }
  }
  async function refreshIntegrations(generation = dataGeneration.current) {
    const request = ++integrationRequest.current;
    setIntegrationLoading(true);
    setIntegrationError("");
    try {
      const result = await api<{ snapshot: IntegrationSnapshot }>("/api/integrations");
      if (dataGeneration.current === generation && integrationRequest.current === request) setIntegrationSnapshot(result.snapshot);
    } catch {
      if (dataGeneration.current === generation && integrationRequest.current === request) setIntegrationError("无法读取服务接入状态，请稍后重试。");
    } finally {
      if (dataGeneration.current === generation && integrationRequest.current === request) setIntegrationLoading(false);
    }
  }
  useEffect(() => {
    const request = ++homeFontRequest.current;
    const generation = dataGeneration.current;
    if (auth !== "ready") {
      setHomeFont("calligraphy");
      setHomeFontDraft("calligraphy");
      setHomeFontStatus("");
      setHomeFontLoading(false);
      return;
    }
    setHomeFontLoading(true);
    api<{ homeFont: HomeFontId }>("/api/settings").then((result) => {
      if (dataGeneration.current !== generation || homeFontRequest.current !== request) return;
      const selected = HOME_FONT_IDS.includes(result.homeFont) ? result.homeFont : "calligraphy";
      setHomeFont(selected);
      setHomeFontDraft(selected);
      setHomeFontStatus("");
    }).catch(() => {
      if (dataGeneration.current === generation && homeFontRequest.current === request) setHomeFontStatus("无法读取首页字体设置，请刷新重试。");
    }).finally(() => {
      if (dataGeneration.current === generation && homeFontRequest.current === request) setHomeFontLoading(false);
    });
    return () => { homeFontRequest.current += 1; };
  }, [auth]);
  useEffect(() => {
    const generation = dataGeneration.current;
    if (auth !== "ready") {
      setTaskSnapshot(null); setTaskLoading(false); setTaskError("");
      setIntegrationSnapshot(null); setIntegrationLoading(false); setIntegrationError("");
      return;
    }
    void refreshTasks(generation);
    void refreshIntegrations(generation);
    return () => { dataGeneration.current += 1; };
  }, [auth]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", dark ? "#060709" : "#f4f5f7");
    writePreference("nexus-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    writePreference("nexus-favorites", JSON.stringify(favorites));
  }, [favorites]);
  useEffect(() => {
    if (auth !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        setMenu(false);
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
        const st = await api<{ bootstrapped: boolean; usernameLoginEnabled?: boolean }>("/api/auth/status");
        if (live) setUsernameLogin(st.usernameLoginEnabled === true);
        if (!st.bootstrapped) {
          if (live) setAuth("bootstrap");
          return;
        }
        try {
          const me = await api<{ user: User }>("/api/auth/me");
          if (live) {
            activateSession(me.user);
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
    const generation = dataGeneration.current;
    const request = ++directoryRequest.current;
    setDirectoryState("loading");
    loadDirectory()
      .then(([s, g, e]) => {
        if (live && dataGeneration.current === generation && directoryRequest.current === request) {
          setDirectoryState("ready");
          setServices(s.services);
          setGroups(g.groups);
          setEvents(e.events);
        }
      })
      .catch(() => {
        if (live && dataGeneration.current === generation && directoryRequest.current === request) {
          setDirectoryState("error");
          setError("无法读取面板数据，请重试或重新登录");
        }
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
  async function check(s: Service) {
    const generation = dataGeneration.current;
    const request = ++checkRequest.current;
    const current = () => dataGeneration.current === generation && checkRequest.current === request;
    setLoading(true);
    setError("");
    try {
      const r = await api<{ service: Service }>(`/api/services/${s.id}/check`, {
        method: "POST",
      });
      if (!current()) return;
      setServices((xs) => xs.map((x) => (x.id === s.id ? r.service : x)));
      setSelected((selectedService) => selectedService?.id === s.id ? r.service : selectedService);
      const result = await loadEvents();
      if (current()) setEvents(result.events);
    } catch (cause) {
      if (current()) setError(actionError(cause, "检查失败，请确认服务地址和网络连接"));
    } finally {
      if (current()) setLoading(false);
    }
  }
  async function saveService(data: Record<string, unknown>) {
    if (serviceForm === null) return;
    const generation = dataGeneration.current;
    const form = serviceForm;
    const result = await api<{ service: Service }>(
      form ? `/api/services/${form.id}` : "/api/services",
      { method: form ? "PATCH" : "POST", body: JSON.stringify(data) },
    );
    if (dataGeneration.current !== generation) return;
    setServices((current) => form
      ? current.map((s) => s.id === result.service.id ? result.service : s)
      : [...current, result.service]);
    if (form && form.slug !== result.service.slug) {
      setFavorites((current) => current.map((slug) =>
        slug === form.slug ? result.service.slug : slug));
    }
    setServiceForm(null);
    setSelected(result.service);
    setError("");
  }
  async function deleteService(s: Service) {
    const generation = dataGeneration.current;
    if (!window.confirm(`删除服务“${s.name}”？`)) return;
    try {
      await api(`/api/services/${s.id}`, { method: "DELETE" });
      if (dataGeneration.current !== generation) return;
      setServices((xs) => xs.filter((x) => x.id !== s.id));
      setFavorites((current) => current.filter((slug) => slug !== s.slug));
      setSelected(null);
    } catch (cause) {
      if (dataGeneration.current === generation) setError(actionError(cause, "删除失败，请稍后重试。"));
    }
  }
  async function refreshData() {
    const generation = dataGeneration.current;
    const request = ++directoryRequest.current;
    const current = () => dataGeneration.current === generation && directoryRequest.current === request;
    void refreshTasks(generation);
    void refreshIntegrations(generation);
    setDirectoryState("loading");
    setRefreshing(true);
    try {
      const [s, g, e] = await loadDirectory();
      if (!current()) return;
      setDirectoryState("ready");
      setServices(s.services);
      setGroups(g.groups);
      setEvents(e.events);
      setActive((current) => current.startsWith("group:") &&
        !g.groups.some((group) => `group:${group.id}` === current) ? "services" : current);
      setError("");
    } catch {
      if (current()) {
        setDirectoryState("error");
        setError("刷新失败，请确认登录状态和服务连接");
      }
    } finally {
      if (current()) setRefreshing(false);
    }
  }
  function toggleFavorite(service: Service) {
    setFavorites((current) =>
      current.includes(service.slug)
        ? current.filter((slug) => slug !== service.slug)
        : [...current, service.slug],
    );
  }
  async function logout() {
    if (logoutPending.current) return;
    const generation = dataGeneration.current;
    logoutPending.current = true;
    setLoggingOut(true);
    try {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } catch (cause) {
        if (dataGeneration.current !== generation) return;
        if (!(cause instanceof ApiError) || cause.status !== 401) {
          setError("退出失败，请重试");
          return;
        }
      }
      if (dataGeneration.current !== generation) return;
      dataGeneration.current += 1;
      directoryRequest.current += 1;
      checkRequest.current += 1;
      setSelected(null);
      setServiceForm(null);
      setManagementAction(null);
      setCommandOpen(false);
      setLoading(false);
      setRefreshing(false);
      setQuery("");
      setStatusFilter("all");
      setTaskSnapshot(null); setTaskLoading(false); setTaskError("");
      setIntegrationSnapshot(null); setIntegrationLoading(false); setIntegrationError("");
      setAuth("login");
      setUser(null);
      setServices([]);
      setDirectoryState("loading");
      setGroups([]);
      setEvents([]);
      setActive("overview");
      setMenu(false);
      setNotice("");
      setError("");
    } finally {
      logoutPending.current = false;
      setLoggingOut(false);
    }
  }
  useEffect(() => {
    if (!inManagement) {
      setServiceForm(null);
      setManagementAction(null);
    }
  }, [inManagement]);
  const viewGeneration = dataGeneration.current;
  const activeTitle =
    active === "overview"
      ? "我的空间"
      : active === "services"
        ? "服务管理"
        : active === "favorites"
          ? "收藏服务"
          : active === "tasks"
            ? "任务中心"
            : active === "integrations"
              ? "服务接入"
          : active === "events"
            ? "运行事件"
            : active === "groups"
              ? "分组管理"
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
        usernameLogin={usernameLogin}
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
            activateSession(res.user);
          } catch (cause) {
            if (cause instanceof ApiError && cause.status === 409) {
              setAuth("login");
              setAuthError("已经初始化，请登录");
            } else if (cause instanceof ApiError && cause.status === 429) {
              setAuthError("尝试次数过多，请稍后再试");
            } else if (cause instanceof ApiError && (cause.code === "origin_forbidden" || cause.status === 403)) {
              setAuthError("当前访问地址未被服务器允许，请联系管理员检查公网代理配置。");
            } else if (cause instanceof ApiError && cause.status === 400 && cause.code === "invalid_input") {
              setAuthError(auth === "bootstrap" ? "请填写有效邮箱，密码至少12个字符。" : usernameLogin ? "请填写有效的用户名或邮箱和密码。" : "请填写有效邮箱和密码。");
            } else if (auth === "login" && cause instanceof ApiError && cause.status === 401) {
              setAuthError("邮箱或密码不正确");
            } else if (cause instanceof ApiError && cause.status >= 500) {
              setAuthError("认证服务暂时不可用，请稍后重试。");
            } else if (!(cause instanceof ApiError)) {
              setAuthError("无法连接认证服务，请检查网络后重试。");
            } else {
              setAuthError("认证请求失败，请稍后重试。");
            }
          }
        }}
      />
    );
  return (
    <div className={"app-shell " + (inManagement ? "admin-shell" : "website-shell")}>
      {inManagement && <aside ref={navRef} id="primary-navigation" inert={!wideNavigation && !menu} role={menu && !wideNavigation ? "dialog" : undefined}
        aria-modal={menu && !wideNavigation ? true : undefined} aria-label={menu && !wideNavigation ? "导航" : "管理导航"}
        className={"sidebar " + (wideNavigation || menu ? "open" : "")}>
        <div className="brand">
          <div className="brand-mark">
            <Orbit size={21} />
          </div>
          <span>Nexus <small>管理</small></span>
        </div>
        <button className="close-nav" aria-label="关闭导航" onClick={() => setMenu(false)}>
          <X size={18} />
        </button>
        <nav>
          <button
            className=""
            onClick={() => {
              setActive("overview");
              setMenu(false);
            }}
          >
            <LayoutDashboard size={17} />
            返回首页
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
            服务管理
            <em>{directoryState === "ready" || services.length > 0 ? services.length : "—"}</em>
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
          <button className={active === "groups" ? "active" : ""} onClick={() => { setActive("groups"); setMenu(false); }}>
            <FolderPlus size={17} />分组管理
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
              <span className="nav-text">{g.name}</span>
              <em>{services.filter((s) => s.groupId === g.id).length}</em>
            </button>
          ))}
          <div className="nav-label">运行概况</div>
          <button
            className={active === "tasks" ? "active" : ""}
            onClick={() => { setActive("tasks"); setMenu(false); }}
          >
            <CalendarClock size={17} />
            任务中心
          </button>
          <button
            className={active === "integrations" ? "active" : ""}
            onClick={() => { setActive("integrations"); setMenu(false); }}
          >
            <Plug2 size={17} />
            服务接入
          </button>
          <div className="nav-label">系统</div>
          {canWrite && (
            <>
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
              disabled={loggingOut}
              aria-busy={loggingOut}
              onClick={logout}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>}
      {inManagement && menu && !wideNavigation && <div className="nav-scrim" aria-hidden="true" onClick={() => setMenu(false)} />}
      <main ref={mainRef} className="main" tabIndex={-1}>
        {inManagement && (
          <header className="topbar admin-topbar">
            <button className="menu-btn" aria-label="打开导航" aria-controls="primary-navigation" aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu(true)}><Menu size={21} aria-hidden="true" /></button>
            <div className="admin-breadcrumb"><span>管理</span><ChevronRight size={14} aria-hidden="true" /><strong>{activeTitle}</strong></div>
            <div className="top-actions">
              <button className="search-trigger" aria-label="搜索服务" onClick={() => setCommandOpen(true)}><Search size={16} aria-hidden="true" /><span>搜索服务</span><kbd>⌘ K</kbd></button>
              <button className="icon-btn" onClick={() => setDark(!dark)} aria-label="切换主题">{dark ? <Sun size={19} aria-hidden="true" /> : <Moon size={19} aria-hidden="true" />}</button>
              <button className="back-to-site" onClick={() => setActive("overview")}><ArrowUpRight size={16} aria-hidden="true" />返回首页</button>
            </div>
          </header>
        )}
        <div className="content">
          {inManagement && active !== "integrations" && active !== "tasks" && (
            <div className="page-head">
              <div>
                <h1>{activeTitle}</h1>
                <p>
                  {active === "events"
                    ? "近期健康检查与管理操作记录。"
                    : active === "groups"
                      ? "整理服务的分类与顺序。"
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
                {canWrite && (active === "groups" ? (
                  <button className="primary" onClick={() => setManagementAction({ type: "group" })}><FolderPlus size={16} aria-hidden="true" />新建分组</button>
                ) : active !== "settings" && active !== "events" && (
                  <button className="primary" aria-label="添加服务" onClick={() => setServiceForm(false)}><Plus size={16} aria-hidden="true" />添加服务</button>
                ))}
              </div>
            </div>
          )}
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
            <Home
              services={services}
              groups={groups}
              favorites={favorites}
              homeFont={homeFont}
              directoryState={directoryState}
              refreshing={refreshing}
              taskSnapshot={taskSnapshot}
              taskLoading={taskLoading}
              taskError={taskError}
              onRefresh={refreshData}
              onRefreshTasks={() => void refreshTasks()}
              onManage={() => setActive("services")}
              onSearch={() => setCommandOpen(true)}
              onDetails={setSelected}
              onToggleFavorite={toggleFavorite}
            />
          ) : active === "tasks" ? (
            <Tasks snapshot={taskSnapshot} loading={taskLoading} error={taskError} onRefresh={() => void refreshTasks()} />
          ) : active === "integrations" ? (
            <Integrations snapshot={integrationSnapshot} loading={integrationLoading} error={integrationError}
              onRefresh={() => void refreshIntegrations()}
              onOpenService={slug => {
                const service = services.find(item => item.slug === slug);
                if (service) setSelected(service);
                else setNotice("此接入尚未关联到当前服务目录。");
              }} />
          ) : active === "events" ? (
            <section className="panel full-panel">
              <PanelHeader title="运行事件" count={directoryState === "ready" || events.length > 0 ? events.length : undefined} action="" />
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
                    <strong>{directoryState === "loading" ? "正在读取事件" : directoryState === "error" ? "事件尚未读取" : "暂无事件"}</strong>
                    <span>{directoryState === "ready" ? "服务事件会显示在这里。" : "完成读取后再确认事件记录。"}</span>
                  </div>
                )}
              </div>
            </section>
          ) : active === "groups" ? (
            <section className="panel full-panel group-management" aria-label="分组管理">
              <PanelHeader title="服务分组" count={directoryState === "ready" || groups.length > 0 ? groups.length : undefined} action="" />
              <div className="group-management-list">
                {groups.map(group => (
                  <div className="group-management-row" key={group.id}>
                    <span className="group-dot" style={{ background: group.color }} aria-hidden="true" />
                    <div><strong>{group.name}</strong><span>{services.filter(service => service.groupId === group.id).length} 个服务</span></div>
                    {canWrite && <button className="secondary" aria-label={"编辑分组" + group.name} onClick={() => setManagementAction({ type: "group", group })}>编辑分组</button>}
                  </div>
                ))}
                {!groups.length && <div className="empty-state"><FolderPlus /><strong>{directoryState === "loading" ? "正在读取分组" : directoryState === "error" ? "分组尚未读取" : "还没有分组"}</strong><span>{directoryState === "ready" ? canWrite ? "点击“新建分组”，整理你的服务入口。" : "管理员创建的分组会显示在这里。" : "读取完成后再确认现有分组。"}</span></div>}
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
                    <span>选择工作台的显示主题。</span>
                  </div>
                  <button className="secondary" onClick={() => setDark((value) => !value)}>
                    {dark ? "深色模式" : "浅色模式"}
                  </button>
                </div>
                <div className="setting-row home-font-setting">
                  <div>
                    <strong>首页字体</strong>
                    <span>仅调整首页展示标题和内嵌任务标题。</span>
                  </div>
                  {user?.role === "admin" ? (
                    <div className="home-font-control">
                      <div>
                        <label className="sr-only" htmlFor="home-font-choice">首页字体</label>
                        <select
                          id="home-font-choice"
                          value={homeFontDraft}
                          disabled={homeFontLoading || homeFontSaving}
                          onChange={(event) => { setHomeFontDraft(event.target.value as HomeFontId); setHomeFontStatus(""); }}
                        >
                          {HOME_FONT_IDS.map((font) => <option key={font} value={font}>{HOME_FONTS[font].label}</option>)}
                        </select>
                        <span className="home-font-preview" style={{ fontFamily: HOME_FONTS[homeFontDraft].family }}>
                          常用服务 · Nexus 工作台
                        </span>
                      </div>
                      <div className="home-font-save">
                        <button className="secondary" onClick={() => void saveHomeFont()} disabled={homeFontLoading || homeFontSaving || homeFontDraft === homeFont}>
                          {homeFontSaving ? "保存中…" : "保存字体"}
                        </button>
                        <span role="status" aria-live="polite">{homeFontStatus || HOME_FONTS[homeFont].label + " · 已应用"}</span>
                      </div>
                    </div>
                  ) : (
                    <span className="setting-value">{HOME_FONTS[homeFont].label}</span>
                  )}
                </div>
                <div className="setting-row">
                  <div>
                    <strong>收藏服务</strong>
                    <span>收藏仅保存在当前浏览器中。</span>
                  </div>
                  <span className="setting-value">{favorites.length}</span>
                </div>
                <div className="setting-row">
                  <div><strong>服务分组</strong><span>在分组管理中整理服务分类。</span></div>
                  <button className="secondary" onClick={() => setActive("groups")}>分组管理</button>
                </div>
              </div>
            </section>
          ) : (
            <section className="panel full-panel">
              <PanelHeader
                title={active === "favorites" ? "收藏服务" : "服务列表"}
                count={directoryState === "ready" || services.length > 0 ? activeServices.length : undefined}
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
                  <strong>{directoryState === "loading" ? "正在读取服务目录" : directoryState === "error" ? "服务目录读取失败" : active === "favorites" ? "还没有收藏服务" : "还没有服务"}</strong>
                  <span>{directoryState !== "ready" ? "读取完成后再确认服务和收藏，现有入口不会被修改。" : active === "favorites" ? "在服务详情中收藏常用入口。" : "添加一个服务来开始监控运行状态。"}</span>
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
            {inManagement && canWrite && (
              <button
                className="primary wide"
                onClick={() => check(selected)}
                disabled={loading}
              >
                <RefreshCw size={15} className={loading ? "spin" : ""} />
                {loading ? "检查中..." : "立即检查"}
              </button>
            )}
            {!inManagement && canWrite && <button className="secondary wide" onClick={() => setActive("services")}><Settings size={15} aria-hidden="true" />管理此服务</button>}
            <div className="drawer-actions">
              {inManagement && canWrite && (
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
              {inManagement && canDelete && (
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
      {inManagement && serviceForm !== null && (
        <ServiceForm
          service={serviceForm || undefined}
          groups={groups}
          onClose={() => setServiceForm(null)}
          onSave={saveService}
        />
      )}
      {inManagement && managementAction && (
        <ManagementDialog
          action={managementAction}
          canDelete={canDelete}
          onClose={() => setManagementAction(null)}
          onDone={(message) => {
            if (dataGeneration.current !== viewGeneration) return;
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
          <h2>{title}</h2>
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
