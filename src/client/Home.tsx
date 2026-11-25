import { useMemo, type CSSProperties, type PointerEvent } from "react";
import {
  AlertCircle, AppWindow, ArrowUpRight, BookOpen, Cloud, FolderOpen, Globe2,
  HardDrive, Image, Info, Layers3, Network, NotebookPen, Play, RefreshCw,
  Settings, Sparkles, Star, Workflow,
} from "lucide-react";
import type { Group, Service } from "../server/types";
import type { TaskSnapshot } from "../shared/tasks";
import { HOME_FONTS, type HomeFontId } from "../shared/home-fonts";
import { Tasks } from "./Tasks";
import "./home.css";

export interface HomeProps {
  services: Service[];
  groups?: Group[];
  favorites: string[];
  homeFont?: HomeFontId;
  refreshing: boolean;
  directoryState?: "loading" | "ready" | "error";
  taskSnapshot?: TaskSnapshot | null;
  taskLoading?: boolean;
  taskError?: string;
  onRefresh: () => void;
  onRefreshTasks?: () => void;
  onManage?: () => void;
  onSearch?: () => void;
  onDetails: (service: Service) => void;
  onToggleFavorite: (service: Service) => void;
}

const ENTER_DELAYS = [0, 32, 60, 86, 108, 128, 146, 162, 176];

export function Home({
  services, favorites, homeFont = "calligraphy", refreshing, directoryState = "ready",
  taskSnapshot = null, taskLoading = false, taskError = "",
  onRefresh, onRefreshTasks, onManage, onDetails, onToggleFavorite,
}: HomeProps) {
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const visibleServices = useMemo(
    () =>
      services
        .map((service, index) => ({ service, index }))
        .sort((a, b) => Number(favoriteSet.has(b.service.slug)) - Number(favoriteSet.has(a.service.slug)) || a.index - b.index)
        .map(({ service }) => service),
    [services, favoriteSet],
  );
  const directoryKnown = directoryState === "ready" || services.length > 0;

  return (
    <div
      className="nexus-home nx-workbench nx-focused"
      data-home-font={homeFont}
      style={{ "--nx-home-font-family": HOME_FONTS[homeFont].family } as CSSProperties}
    >
      <h1 className="sr-only">工作台</h1>

      {onManage && (
        <div className="nx-top-utility">
          <button className="nx-dock-btn" aria-label="进入管理" onClick={onManage}>
            <Settings size={15} aria-hidden="true" />
            <span>管理</span>
          </button>
        </div>
      )}

      <div className="nx-body">
        <section className="nx-directory" aria-labelledby="nx-services-title" aria-busy={directoryState === "loading"}>
          <h2 className="sr-only" id="nx-services-title">全部服务</h2>

          {services.length > 0 && directoryState === "error" && (
            <div className="nx-directory-notice" role="status">
              <AlertCircle size={16} aria-hidden="true" />
              <span>刷新失败，正在显示上次读取的服务。</span>
              <button onClick={onRefresh} disabled={refreshing}>重试</button>
            </div>
          )}

          <div className="nexus-service-grid nx-service-grid">
            {visibleServices.map((service, index) => (
              <ServiceTile
                key={service.id}
                service={service}
                index={index}
                favorite={favoriteSet.has(service.slug)}
                onDetails={() => onDetails(service)}
                onFavorite={() => onToggleFavorite(service)}
              />
            ))}

            {services.length === 0 && directoryState === "loading" ? (
              <div className="nx-empty" role="status">
                <RefreshCw size={28} className="spin" aria-hidden="true" />
                <h3>正在读取服务目录</h3>
                <p>请稍候。</p>
              </div>
            ) : services.length === 0 && directoryState === "error" ? (
              <div className="nx-empty" role="status">
                <AlertCircle size={28} aria-hidden="true" />
                <h3>服务目录读取失败</h3>
                <p>暂时无法确认已有服务，请重试读取。</p>
                <button className="nx-button nx-button-quiet" aria-label="重试读取服务目录" onClick={onRefresh} disabled={refreshing}>重新读取</button>
              </div>
            ) : services.length === 0 ? (
              <div className="nx-empty">
                <AppWindow size={30} aria-hidden="true" />
                <h3>还没有服务</h3>
                <p>请在“管理”中添加常用的网站和自托管服务。</p>
              </div>
            ) : null}
          </div>
          <span className="sr-only" role="status">{!directoryKnown ? directoryState === "loading" ? "正在读取服务目录" : "服务目录尚未读取" : ""}</span>
        </section>
      </div>

      <section className="nx-schedule-section" aria-label="定时任务">
        <Tasks
          embedded
          snapshot={taskSnapshot}
          loading={taskLoading}
          error={taskError}
          onRefresh={onRefreshTasks ?? onRefresh}
        />
      </section>
    </div>
  );
}

function serviceGlyph(service: Service) {
  const text = [service.name, service.slug, ...service.tags].join(" ").toLocaleLowerCase();
  if (/photo|image|immich|相册|照片/.test(text)) return Image;
  if (/media|jellyfin|cinema|movie|music|audio|vod|影音|媒体|音乐|影院|电影|点播/.test(text)) return Play;
  if (/reading|reader|books?|阅读|书籍|书库/.test(text)) return BookOpen;
  if (/notebook|notes?|memos|笔记|随手记/.test(text)) return NotebookPen;
  if (/automation|automate|workflow|自动化|工作流/.test(text)) return Workflow;
  if (/network|gateway|speed|router|网络|测速|网关/.test(text)) return Network;
  if (/archive|storage|disk|存储|备份/.test(text)) return HardDrive;
  if (/file|drive|openlist|文件|网盘/.test(text)) return FolderOpen;
  if (/cloud|workspace|云|工作空间/.test(text)) return Cloud;
  if (/assistant|智能|人工智能|(^|[\s-])ai([\s-]|$)/.test(text)) return Sparkles;
  if (/web|site|blog|wordpress|网站|博客/.test(text)) return Globe2;
  return Layers3;
}

function trackSpotlight(event: PointerEvent<HTMLElement>) {
  if (event.pointerType !== "mouse") return;
  if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const tile = event.currentTarget;
  const rect = tile.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  tile.style.setProperty("--mx", `${(event.clientX - rect.left).toFixed(1)}px`);
  tile.style.setProperty("--my", `${(event.clientY - rect.top).toFixed(1)}px`);
}

function clearSpotlight(event: PointerEvent<HTMLElement>) {
  event.currentTarget.style.removeProperty("--mx");
  event.currentTarget.style.removeProperty("--my");
}

function ServiceTile({
  service, index, favorite, onDetails, onFavorite,
}: {
  service: Service;
  index: number;
  favorite: boolean;
  onDetails: () => void;
  onFavorite: () => void;
}) {
  const safeUrl = /^https?:\/\//i.test(service.url);
  const Glyph = serviceGlyph(service);
  const tone = index % 5;
  const slot = index % 9;
  const enterDelay = ENTER_DELAYS[index] ?? 190;
  const content = (
    <>
      <strong className="nx-tile-name">{service.name}</strong>
      <ArrowUpRight className="nx-tile-arrow" size={20} strokeWidth={1.9} aria-hidden="true" />
    </>
  );

  return (
    <article
      className={`nexus-service-card nx-service-tile nx-tile-tone-${tone} nx-slot-${slot}`}
      style={{ "--enter-delay": `${enterDelay}ms` } as CSSProperties}
      onPointerMove={trackSpotlight}
      onPointerLeave={clearSpotlight}
    >
      <div className="nx-tile-bg" data-index={String(index + 1).padStart(2, "0")} aria-hidden="true">
        <Glyph size={98} strokeWidth={1.2} />
      </div>
      {safeUrl ? (
        <a className="nexus-service-open nx-tile-link" href={service.url} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      ) : (
        <div className="nexus-service-open nx-tile-link nx-no-url">
          {content}
        </div>
      )}
      <div className="nx-tile-actions">
        <button
          className="nexus-card-favorite nx-icon-button"
          aria-label={(favorite ? "取消收藏" : "收藏") + service.name}
          aria-pressed={favorite}
          onClick={onFavorite}
        >
          <Star size={17} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
        </button>
        <button
          className="nexus-card-details nx-icon-button"
          aria-label={"查看" + service.name + "详情"}
          onClick={onDetails}
        >
          <Info size={17} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
