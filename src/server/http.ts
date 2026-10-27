import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { authFromToken, requirePermission, type AuthContext } from "./auth/context";
import type { Permission } from "./auth/rbac";
import { readCookie, SESSION_COOKIE } from "./auth/session";
import { config } from "./config";
import { AppError } from "./errors";
import { log } from "./logger";
import { rateLimit } from "./ratelimit";

export interface RouteArgs<P> {
  req: Request;
  ctx: AuthContext;
  params: P;
  requestId: string;
}

type RouteOptions = {
  permission: Permission;
  /** Skip the per-user write rate limit (e.g. read-only POST queries). */
  noRateLimit?: boolean;
};

export function clientIp(req: Request) {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || null;
}

/** Reject cross-site state-changing requests (cookie-authenticated API). */
export function checkCsrf(req: Request) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const origin = req.headers.get("origin");
  const allowed = new URL(config().APP_URL).origin;
  if (origin && origin !== allowed) throw new AppError("CSRF_REJECTED", "Cross-origin request rejected");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    throw new AppError("CSRF_REJECTED", "Cross-site request rejected");
}

export function errorResponse(e: unknown, requestId: string) {
  let err: AppError;
  if (e instanceof AppError) err = e;
  else if (e instanceof ZodError)
    err = new AppError(
      "VALIDATION_ERROR",
      "Request validation failed",
      e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  else {
    log.error("Unhandled API error", { requestId, error: e instanceof Error ? e : String(e) });
    err = new AppError("INTERNAL", "An unexpected error occurred");
  }
  return Response.json(
    { error: { code: err.code, message: err.message, details: err.details, requestId } },
    { status: err.status, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

/** Wrap an authenticated API route handler. */
export function apiRoute<P = Record<string, string>>(
  opts: RouteOptions,
  handler: (a: RouteArgs<P>) => Promise<unknown>,
) {
  return async (req: Request, routeCtx?: { params?: Promise<P> }) => {
    const requestId = req.headers.get("x-request-id")?.slice(0, 64) || randomUUID();
    const started = Date.now();
    try {
      checkCsrf(req);
      const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
      const ctx = await authFromToken(token, { requestId, ip: clientIp(req) });
      requirePermission(ctx, opts.permission);
      if (ctx.mustChangePassword)
        throw new AppError("FORBIDDEN", "You must change your temporary password first");
      if (req.method !== "GET" && !opts.noRateLimit)
        await rateLimit(`write:${ctx.userId}`, config().API_WRITE_RATE_LIMIT_PER_MIN, 60);
      const params = ((await routeCtx?.params) ?? {}) as P;
      const result = await handler({ req, ctx, params, requestId });
      const res =
        result instanceof Response
          ? result
          : Response.json(result ?? { data: null }, { headers: { "cache-control": "no-store" } });
      res.headers.set("x-request-id", requestId);
      log.info("api", {
        requestId,
        method: req.method,
        path: new URL(req.url).pathname,
        status: res.status,
        ms: Date.now() - started,
      });
      return res;
    } catch (e) {
      const res = errorResponse(e, requestId);
      log.info("api", {
        requestId,
        method: req.method,
        path: new URL(req.url).pathname,
        status: res.status,
        ms: Date.now() - started,
      });
      return res;
    }
  };
}

export async function readJson(req: Request, maxBytes = 1_000_000): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "Request body too large");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON");
  }
}

export interface Page {
  limit: number;
  offset: number;
}

export function pageParams(url: URL, maxLimit = 500): Page {
  const limit = Math.min(maxLimit, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  return { limit, offset };
}

export function ok<T>(data: T, meta?: Record<string, unknown>) {
  return { data, ...(meta ? { meta } : {}) };
}

export function paged<T>(r: { items: T[]; total: number }, p: Page, extra: Record<string, unknown> = {}) {
  return { data: r.items, meta: { total: r.total, limit: p.limit, offset: p.offset, ...extra } };
}

/** Wrapper for routes that are public or handle their own session (login, logout, password). */
export function publicRoute(handler: (req: Request, requestId: string) => Promise<Response>) {
  return async (req: Request) => {
    const requestId = req.headers.get("x-request-id")?.slice(0, 64) || randomUUID();
    try {
      checkCsrf(req);
      const res = await handler(req, requestId);
      res.headers.set("x-request-id", requestId);
      res.headers.set("cache-control", "no-store");
      return res;
    } catch (e) {
      return errorResponse(e, requestId);
    }
  };
}
