"use client";

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Same-origin JSON API call. Throws ApiError with the server's structured error. */
export async function api<T = unknown>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ data: T; meta?: Record<string, unknown> }> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Full reload on session expiry deliberately discards all client state.
    // Auth endpoints report their own 401s (e.g. wrong password) and must not redirect.
    const sessionExpired =
      res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/v1/auth/");
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (sessionExpired) window.location.href = "/login";
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status})`,
      body?.error?.code ?? "ERROR",
      res.status,
      body?.error?.details,
    );
  }
  return body;
}

export function errorText(e: unknown) {
  if (e instanceof ApiError && Array.isArray(e.details))
    return `${e.message}: ${(e.details as { path?: string; message?: string; rowNumber?: number }[])
      .slice(0, 5)
      .map((d) =>
        d.rowNumber ? `row ${d.rowNumber}: ${d.message}` : d.path ? `${d.path}: ${d.message}` : d.message,
      )
      .join("; ")}`;
  return e instanceof Error ? e.message : String(e);
}
