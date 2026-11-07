import { NextResponse } from "next/server";

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function jsonError(status: number, message: string, code = "error") {
  return NextResponse.json({ error: message, code }, { status });
}

export async function handleRoute(
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonError(error.status, error.message, error.code);
    }
    console.error("[api] unhandled error", error);
    return jsonError(500, "حدث خطأ غير متوقع في الخادم", "internal");
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "صيغة الطلب غير صحيحة", "bad_json");
  }
}

export function assertString(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; optional?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    throw new HttpError(400, `الحقل ${field} مطلوب`, "missing_field");
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `الحقل ${field} يجب أن يكون نصاً`, "bad_field");
  }
  const trimmed = value.trim();
  if (!opts.optional && trimmed.length === 0) {
    throw new HttpError(400, `الحقل ${field} مطلوب`, "missing_field");
  }
  if (opts.min !== undefined && trimmed.length < opts.min) {
    throw new HttpError(
      400,
      `الحقل ${field} يجب ألا يقل عن ${opts.min} محرف`,
      "bad_field",
    );
  }
  if (opts.max !== undefined && trimmed.length > opts.max) {
    throw new HttpError(
      400,
      `الحقل ${field} يجب ألا يتجاوز ${opts.max} محرف`,
      "bad_field",
    );
  }
  return trimmed;
}
