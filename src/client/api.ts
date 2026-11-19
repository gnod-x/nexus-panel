export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const method = options?.method ?? "GET";
  const mutation = method === "POST" || method === "PATCH" || method === "DELETE";
  if (mutation) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers,
    body: options?.body ?? (mutation ? "{}" : undefined),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error ?? "request_failed");
  return data;
}

export function actionError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 401) return "会话已过期，请重新登录。";
  if (error.status === 403) return "当前账户无权执行此操作。";
  if (error.code === "invalid_target") return "请检查 HTTP(S) 地址和探测网络配置。";
  if (error.code === "missing_group") return "所选分组不存在，请刷新后重试。";
  if (error.status === 409) return "标识符已存在，请使用不同的标识符。";
  if (error.status === 413) return "导入文件不超过 1 MiB。";
  if (error.status === 400) return "输入内容不符合要求，请检查后重试。";
  return fallback;
}
