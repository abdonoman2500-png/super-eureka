"use client";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        setTimeout(() => {
          refreshing = null;
        }, 50);
      });
  }
  return refreshing;
}

/** Fetch wrapper with transparent access-token rotation. */
export async function api<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const run = () =>
    fetch(path, {
      credentials: "include",
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      ...init,
    });

  let response = await run();
  if (response.status === 401 && retry && !path.includes("/api/auth/")) {
    const ok = await refreshSession();
    if (ok) response = await run();
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const err = payload as { error?: string; code?: string } | null;
    throw new ApiError(
      response.status,
      err?.error ?? "فشل الاتصال بالخادم",
      err?.code ?? "error",
    );
  }
  return payload as T;
}

export const jsonBody = (value: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(value),
});
