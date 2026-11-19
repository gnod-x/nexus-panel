import { useState } from "react";
import { FolderPlus, Upload, X } from "lucide-react";
import type { Group } from "../server/types";
import { actionError, api } from "./api";
import { Dialog } from "./Dialog";

export type ManagementAction =
  | { type: "group"; group?: Group }
  | { type: "import" };

export function ManagementDialog({ action, canDelete, onClose, onDone }: {
  action: ManagementAction;
  canDelete: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const group = action.type === "group" ? action.group : undefined;
  const [name, setName] = useState(group?.name ?? "");
  const [slug, setSlug] = useState(group?.slug ?? "");
  const [color, setColor] = useState(group?.color ?? "#3b82f6");
  const [preview, setPreview] = useState<{ body: string; groups: number; services: number }>();
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = action.type === "import" ? "导入 Sun-Panel" : group ? "编辑分组" : "添加分组";
  const groupUrl = group ? `/api/groups/${group.id}` : "/api/groups";

  async function readImport(file: File | undefined) {
    setError("");
    setPreview(undefined);
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setError("导入文件不超过 1 MiB。");
      return;
    }
    setReading(true);
    try {
      const body = await file.text();
      const data = JSON.parse(body);
      if (!Array.isArray(data?.groups) || !Array.isArray(data?.services)) {
        throw new Error("invalid import");
      }
      if (data.groups.length > 100 || data.services.length > 500) {
        setError("每次最多导入 100 个分组和 500 个服务。");
        return;
      }
      setPreview({ body, groups: data.groups.length, services: data.services.length });
    } catch {
      setError("请选择由 Sun-Panel 导出脚本生成的 JSON 文件。");
    } finally {
      setReading(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      if (action.type === "import") {
        if (!preview) return;
        const { imported } = await api<{ imported: { groups: number; services: number } }>(
          "/api/import/sun-panel", { method: "POST", body: preview.body },
        );
        onDone(`已导入 ${imported.groups} 个分组、${imported.services} 个服务。`);
      } else {
        await api(groupUrl, { method: group ? "PATCH" : "POST", body: JSON.stringify({ name, slug, color }) });
        onDone(group ? "分组已更新。" : "分组已创建。");
      }
    } catch (cause) {
      setError(actionError(cause, "保存失败，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!group || !window.confirm(`删除分组“${group.name}”？其中的服务将移至未分组。`)) return;
    setBusy(true);
    setError("");
    try {
      await api(groupUrl, { method: "DELETE" });
      onDone("分组已删除。");
    } catch (cause) {
      setError(actionError(cause, "删除分组失败，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog label={title} onClose={() => { if (!busy) onClose(); }}>
      <form className="modal" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {action.type === "import" ? (
          <>
            <label>导入文件<input type="file" accept=".json,application/json" disabled={busy || reading} onChange={(event) => void readImport(event.target.files?.[0])} /></label>
            {preview && <p role="status">预览：{preview.groups} 个分组、{preview.services} 个服务</p>}
          </>
        ) : (
          <>
            <label>分组名称<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>分组标识符<input required pattern="[a-z0-9\-]+" maxLength={96} value={slug} onChange={(event) => setSlug(event.target.value)} /></label>
            <label>颜色<input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
          </>
        )}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <div className="modal-actions">
          {group && canDelete && <button type="button" className="danger" disabled={busy} onClick={remove}>删除分组</button>}
          <button className="primary" type="submit" disabled={busy || (action.type === "import" && !preview)}>
            {action.type === "import" ? <Upload size={15} /> : <FolderPlus size={15} />}
            {action.type === "import" ? "确认导入" : "保存分组"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
