import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosRequestConfig,
} from "axios";
import type { HttpTransportRequest } from "@workspace/api-client";

export type ExAxiosErrorKind =
  | "config"
  | "network"
  | "timeout"
  | "cancelled"
  | "http";
export type ExAxiosRequestConfig = HttpTransportRequest;
export interface SessionExpiredContext {
  error: ExAxiosError;
  loginUrl: string;
}
export interface ExAxiosOptions {
  baseUrl?: string;
  websiteBaseUrl?: string;
  /** Browser binding cookies use Fetch's same-origin policy; cross-origin cookies stay omitted. */
  sameOriginCookies?: boolean;
  alert?: boolean;
  loginUrl?: string;
  onSessionExpired?: (context: SessionExpiredContext) => void | Promise<void>;
}
export interface ExAxiosInstance {
  <T = unknown>(config: ExAxiosRequestConfig): Promise<NoInfer<T>>;
  setBaseUrl(url: string, options?: { website?: boolean }): void;
  setToken(token: string | null): void;
  setAlert(enabled: boolean): void;
}
export class ExAxiosError extends Error {
  readonly kind: ExAxiosErrorKind;
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  constructor(
    kind: ExAxiosErrorKind,
    code: string,
    message: string,
    extra: {
      status?: number;
      requestId?: string;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = "ExAxiosError";
    this.kind = kind;
    this.code = code;
    this.status = extra.status;
    this.requestId = extra.requestId;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
  toJSON() {
    return {
      kind: this.kind,
      code: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }
}

export interface HttpRuntime {
  environment: "browser" | "node";
  origin?: string;
  readToken?: () => string | null | undefined;
  clearToken?: (token: string | null) => boolean;
  notify?: (message: string) => void;
  navigate?: (url: string) => void;
}

const allowedKeys = new Set([
  "url",
  "method",
  "params",
  "data",
  "headers",
  "timeout",
  "signal",
  "responseType",
  "alert",
]);
const methods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
const errorText: Record<ExAxiosErrorKind, string> = {
  config: "请求配置无效",
  network: "网络连接失败，请稍后重试",
  timeout: "请求超时，请稍后重试",
  cancelled: "请求已取消",
  http: "请求失败，请稍后重试",
};
const configError = () =>
  new ExAxiosError("config", "CONFIG_ERROR", errorText.config);

function parseBase(value: string, runtime: HttpRuntime): string {
  if (typeof value !== "string" || !value || /[?#]/.test(value))
    throw configError();
  let url: URL;
  try {
    url = new URL(
      value,
      runtime.environment === "browser" ? runtime.origin : undefined,
    );
  } catch {
    throw configError();
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw configError();
  if (runtime.environment === "node" && !/^https?:\/\//i.test(value))
    throw configError();
  return url.href.replace(/\/+$/, "");
}
function parseLogin(value: string, runtime: HttpRuntime): string {
  let url: URL;
  try {
    url = new URL(
      value,
      runtime.environment === "browser" ? runtime.origin : undefined,
    );
  } catch {
    throw configError();
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw configError();
  return url.href;
}
function defaultLogin(scope: string | undefined): string {
  return scope ? `${new URL(scope).origin}/login` : "/login";
}
function finalUrl(
  baseUrl: string | undefined,
  config: ExAxiosRequestConfig,
): string {
  if (!baseUrl || typeof config.url !== "string" || !config.url)
    throw configError();
  if (/\\/.test(config.url.split(/[?#]/, 1)[0] ?? "")) throw configError();
  let url: URL;
  try {
    url =
      /^https?:\/\//i.test(config.url) || config.url.startsWith("//")
        ? new URL(config.url, baseUrl)
        : new URL(
            `${baseUrl.replace(/\/$/, "")}/${config.url.replace(/^\/+/, "")}`,
          );
  } catch {
    throw configError();
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    /%(?:2f|5c)/i.test(url.pathname)
  )
    throw configError();
  if (config.params !== undefined) {
    const entries =
      config.params instanceof URLSearchParams
        ? [...config.params.entries()]
        : Object.entries(config.params);
    for (const [key, value] of entries) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (!["string", "number", "boolean"].includes(typeof item))
          throw configError();
        url.searchParams.append(key, String(item));
      }
    }
  }
  return url.href;
}
function inScope(url: string, scope: string | undefined): boolean {
  if (!scope) return false;
  const target = new URL(url),
    root = new URL(scope);
  const path = root.pathname.replace(/\/$/, "");
  return (
    target.origin === root.origin &&
    (path === "" ||
      target.pathname === path ||
      target.pathname.startsWith(`${path}/`))
  );
}
function envelope(
  input: unknown,
): { code: string; message: string; requestId: string } | undefined {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1
  )
    return undefined;
  const value = (input as { error?: unknown }).error;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "code,message,requestId"
  )
    return undefined;
  const error = value as Record<string, unknown>;
  return typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.requestId === "string"
    ? (error as { code: string; message: string; requestId: string })
    : undefined;
}
function retryAfter(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? undefined
    : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}
function decodedJson(value: unknown): unknown {
  try {
    return typeof value === "string"
      ? JSON.parse(value)
      : JSON.parse(
          new TextDecoder().decode(
            value instanceof Uint8Array
              ? value
              : new Uint8Array(value as ArrayBuffer),
          ),
        );
  } catch {
    return undefined;
  }
}

export function createHttpCore(
  runtime: HttpRuntime,
  options: ExAxiosOptions = {},
): ExAxiosInstance {
  if (
    !options ||
    typeof options !== "object" ||
    Object.keys(options).some(
      (key) =>
        ![
          "baseUrl",
          "websiteBaseUrl",
          "sameOriginCookies",
          "alert",
          "loginUrl",
          "onSessionExpired",
        ].includes(key),
    )
  )
    throw configError();
  if (options.alert !== undefined && typeof options.alert !== "boolean")
    throw configError();
  if (options.sameOriginCookies !== undefined && typeof options.sameOriginCookies !== "boolean")
    throw configError();
  if (
    options.onSessionExpired !== undefined &&
    typeof options.onSessionExpired !== "function"
  )
    throw configError();
  let baseUrl: string | undefined = runtime.origin
    ? `${runtime.origin}/api`
    : undefined;
  let websiteBaseUrl = baseUrl;
  let token: string | null = null;
  let sessionBound = false;
  let scopeRevision = 0,
    tokenRevision = 0;
  let expiredVersion: string | undefined;
  let alertDefault = options.alert ?? true;
  let loginUrl = defaultLogin(websiteBaseUrl);
  let customLogin = false;
  if (options.baseUrl !== undefined)
    baseUrl = parseBase(options.baseUrl, runtime);
  if (options.websiteBaseUrl !== undefined)
    websiteBaseUrl = parseBase(options.websiteBaseUrl, runtime);
  if (options.loginUrl !== undefined) {
    loginUrl = parseLogin(options.loginUrl, runtime);
    customLogin = true;
  } else loginUrl = defaultLogin(websiteBaseUrl);
  if (runtime.origin && websiteBaseUrl === `${runtime.origin}/api`) {
    try {
      const initial = runtime.readToken?.();
      if (initial !== undefined) sessionBound = true;
      if (initial && !/[\x00-\x1f\x7f]/.test(initial)) token = initial;
    } catch {
      /* public requests remain available */
    }
  }

  function persistedToken(): string | null | undefined {
    try {
      return runtime.readToken?.();
    } catch {
      return undefined;
    }
  }

  function syncPersistedToken(value: string | null | undefined): void {
    token = value && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
    tokenRevision++;
    expiredVersion = undefined;
  }

  const instance = (async <T = unknown>(
    config: ExAxiosRequestConfig,
  ): Promise<T> => {
    if (
      !config ||
      typeof config !== "object" ||
      Object.keys(config).some((key) => !allowedKeys.has(key))
    )
      throw configError();
    if (config.method !== undefined && typeof config.method !== "string")
      throw configError();
    if (
      config.headers !== undefined &&
      (typeof config.headers !== "object" ||
        config.headers === null ||
        Array.isArray(config.headers))
    )
      throw configError();
    if (
      config.params !== undefined &&
      !(config.params instanceof URLSearchParams) &&
      (typeof config.params !== "object" ||
        config.params === null ||
        Array.isArray(config.params))
    )
      throw configError();
    const method = (config.method ?? "GET").toUpperCase();
    if (
      !methods.has(method) ||
      (config.timeout !== undefined &&
        (!Number.isFinite(config.timeout) || config.timeout < 0)) ||
      (config.alert !== undefined && typeof config.alert !== "boolean")
    )
      throw configError();
    const target = finalUrl(baseUrl, config);
    const scoped = inScope(target, websiteBaseUrl);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      if (
        typeof value !== "string" ||
        /^(host|:authority)$/i.test(name) ||
        /[\r\n]/.test(name + value)
      )
        throw configError();
      headers[name] = value;
    }
    const explicit = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "authorization",
    )?.[1];
    if (scoped && token && explicit === undefined)
      headers.Authorization = `Bearer ${token}`;
    const protectedRequest =
      scoped && (explicit !== undefined || token !== null);
    const qualified =
      scoped &&
      (explicit === undefined ||
        (token !== null && explicit === `Bearer ${token}`));
    const requestToken = token,
      requestScope = scopeRevision,
      requestVersion = tokenRevision;
    const resolvedAlert = config.alert ?? alertDefault;
    const responseType = config.responseType ?? "json";
    if (!["json", "text", "blob", "arraybuffer"].includes(responseType))
      throw configError();
    if (config.signal?.aborted)
      throw new ExAxiosError(
        config.signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
        config.signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
        errorText[
          config.signal.reason?.name === "TimeoutError"
            ? "timeout"
            : "cancelled"
        ],
      );

    const requestHeaders = AxiosHeaders.from(headers);
    // Axios otherwise adds a form Content-Type even to bodyless POST requests.
    if (config.data === undefined && !requestHeaders.has("Content-Type"))
      requestHeaders.setContentType(false);
    const request: AxiosRequestConfig = {
      url: target,
      method,
      headers: requestHeaders,
      data: config.data,
      timeout: config.timeout ?? 30_000,
      signal: config.signal,
      responseType:
        responseType === "json" || responseType === "text"
          ? "text"
          : "arraybuffer",
      transformResponse: [(data: unknown) => data],
      validateStatus: () => true,
      // Axios fetch defaults to same-origin only when withCredentials is omitted.
      ...(runtime.environment === "browser" && options.sameOriginCookies ? {} : { withCredentials: false }),
      adapter: runtime.environment === "browser" ? "fetch" : "http",
      ...(runtime.environment === "browser" && protectedRequest
        ? { fetchOptions: { redirect: "error", credentials: options.sameOriginCookies ? "same-origin" : "omit" } }
        : {}),
      ...(runtime.environment === "node" && protectedRequest
        ? { maxRedirects: 0 }
        : {}),
    };
    let response;
    try {
      response = await axios(request);
    } catch (cause) {
      const timedOut =
        config.signal?.reason?.name === "TimeoutError" ||
        (cause instanceof AxiosError &&
          (cause.code === "ECONNABORTED" || cause.code === "ETIMEDOUT"));
      const cancelled =
        !timedOut &&
        (config.signal?.aborted ||
          (cause instanceof AxiosError && cause.code === "ERR_CANCELED"));
      const kind: ExAxiosErrorKind = timedOut
        ? "timeout"
        : cancelled
          ? "cancelled"
          : "network";
      const code = timedOut
        ? "TIMEOUT"
        : cancelled
          ? "CANCELLED"
          : "NETWORK_ERROR";
      const error = new ExAxiosError(kind, code, errorText[kind]);
      if (resolvedAlert && kind !== "cancelled") {
        try {
          runtime.notify?.(error.message);
        } catch {
          /* keep original failure */
        }
      }
      throw error;
    }
    const status = response.status;
    if (status >= 200 && status < 300) {
      if (status === 204) return undefined as T;
      if (responseType === "text") return response.data as T;
      if (responseType === "arraybuffer") {
        const bytes =
          response.data instanceof Uint8Array
            ? response.data
            : new Uint8Array(response.data);
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as T;
      }
      if (responseType === "blob") return new Blob([response.data]) as T;
      const parsed = decodedJson(response.data);
      if (parsed !== undefined) return parsed as T;
    }
    const contentType = String(response.headers["content-type"] ?? "");
    const raw = response.data;
    const size =
      typeof raw === "string"
        ? new TextEncoder().encode(raw).byteLength
        : (raw?.byteLength ?? Number.POSITIVE_INFINITY);
    const parsed =
      /^application\/(?:[\w.+-]*\+)?json\b/i.test(contentType) && size <= 65_536
        ? decodedJson(raw)
        : undefined;
    const safe = scoped ? envelope(parsed) : undefined;
    const error = new ExAxiosError(
      "http",
      safe?.code ?? "HTTP_ERROR",
      safe?.message ?? errorText.http,
      {
        status,
        requestId:
          safe?.requestId ??
          (typeof response.headers["x-request-id"] === "string"
            ? response.headers["x-request-id"]
            : undefined),
        retryAfterSeconds: retryAfter(response.headers["retry-after"]),
      },
    );
    const version = `${requestScope}:${requestVersion}`;
    const expired =
      status === 401 &&
      safe?.code === "SESSION_INVALID" &&
      qualified &&
      requestScope === scopeRevision &&
      requestVersion === tokenRevision &&
      requestToken === token;
    const staleSession =
      status === 401 &&
      safe?.code === "SESSION_INVALID" &&
      qualified &&
      !expired;
    if (expired && expiredVersion !== version) {
      const before = sessionBound ? persistedToken() : requestToken;
      if (sessionBound && before !== requestToken) {
        syncPersistedToken(before);
      } else {
        let cleared = !sessionBound;
        if (sessionBound) {
          try {
            cleared = runtime.clearToken?.(requestToken) === true;
          } catch {
            cleared = false;
          }
        }
        const after = sessionBound ? persistedToken() : null;
        if (!cleared || (sessionBound && after !== null)) {
          syncPersistedToken(after);
        } else {
          expiredVersion = version;
          token = null;
          if (resolvedAlert) {
            try {
              runtime.notify?.(error.message);
            } catch {
              /* keep original failure */
            }
          }
          if (options.onSessionExpired) {
            try {
              void Promise.resolve(
                options.onSessionExpired({ error, loginUrl }),
              ).catch(() => {});
            } catch {
              /* keep original failure */
            }
          } else if (runtime.navigate) {
            try {
              runtime.navigate(loginUrl);
            } catch {
              /* keep original failure */
            }
          }
        }
      }
    } else if (
      resolvedAlert &&
      !expired &&
      !staleSession &&
      expiredVersion !== version
    ) {
      try {
        runtime.notify?.(safe?.message ?? errorText.http);
      } catch {
        /* keep original failure */
      }
    }
    throw error;
  }) as ExAxiosInstance;
  instance.setBaseUrl = (value, change = {}) => {
    if (
      !change ||
      typeof change !== "object" ||
      Object.keys(change).some((key) => key !== "website") ||
      (change.website !== undefined && typeof change.website !== "boolean")
    )
      throw configError();
    const next = parseBase(value, runtime);
    baseUrl = next;
    if (change.website) {
      if (websiteBaseUrl !== next) {
        websiteBaseUrl = next;
        scopeRevision++;
        tokenRevision++;
        token = null;
        sessionBound = false;
        expiredVersion = undefined;
        if (!customLogin) loginUrl = defaultLogin(next);
      }
    }
  };
  instance.setToken = (value) => {
    if (
      value !== null &&
      (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value))
    )
      throw configError();
    token = value;
    tokenRevision++;
    expiredVersion = undefined;
    sessionBound =
      value !== null
        ? persistedToken() === value
        : sessionBound && persistedToken() === null;
  };
  instance.setAlert = (value) => {
    if (typeof value !== "boolean") throw configError();
    alertDefault = value;
  };
  return instance;
}
