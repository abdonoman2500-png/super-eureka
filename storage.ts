import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { signPayload } from "./tokens";

/**
 * Storage abstraction.
 *
 * `s3` driver   : any S3-compatible object store (AWS S3, Cloudflare R2,
 *                 Backblaze B2, Wasabi, MinIO). Pre-signed URLs are produced
 *                 with a dependency-free AWS SigV4 implementation so devices
 *                 upload/download bytes *directly* to the bucket, never through
 *                 the metadata API.
 * `local` driver: filesystem-backed vault used when no bucket is configured.
 *                 It exposes the exact same pre-signed URL contract (HMAC
 *                 signed, expiring, single-purpose) so the client code path is
 *                 identical in both deployments.
 */

export interface CompletedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface ObjectDriver {
  readonly name: "s3" | "local";
  readonly label: string;
  presignPut(
    key: string,
    opts?: { expiresSeconds?: number; partNumber?: number; uploadId?: string },
  ): string;
  presignGet(key: string, expiresSeconds?: number): string;
  initMultipart(key: string): Promise<string>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<{ storedBytes: number; etag: string }>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  putObject(key: string, body: ReadableStream<Uint8Array>): Promise<number>;
  putPart(
    uploadId: string,
    partNumber: number,
    body: ReadableStream<Uint8Array>,
  ): Promise<{ etag: string; size: number }>;
  getObject(
    key: string,
    range?: { start: number; end: number },
  ): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null>;
  deleteObject(key: string): Promise<void>;
  statObject(key: string): Promise<number | null>;
}

/* ------------------------------------------------------------------ *
 * AWS Signature V4 (query-string pre-signing, UNSIGNED-PAYLOAD)
 * ------------------------------------------------------------------ */

interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  forcePathStyle: boolean;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalizePath(key: string): string {
  return `/${key.split("/").map(encodeRfc3986).join("/")}`;
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k])}`)
    .join("&");
}

function sigv4Key(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = crypto
    .createHmac("sha256", `AWS4${secret}`)
    .update(dateStamp)
    .digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto
    .createHmac("sha256", kRegion)
    .update("s3")
    .digest();
  return crypto
    .createHmac("sha256", kService)
    .update("aws4_request")
    .digest();
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function objectUrl(config: S3Config, key: string): URL {
  const canonicalKey = canonicalizePath(key);
  if (config.endpoint) {
    const base = config.endpoint.replace(/\/+$/, "");
    const url = config.forcePathStyle
      ? new URL(`${base}/${config.bucket}${canonicalKey}`)
      : new URL(`${base.replace(/:\/\/([^/]+)/, "://$1.")}${canonicalKey}`);
    return url;
  }
  if (config.forcePathStyle) {
    return new URL(
      `https://s3.${config.region}.amazonaws.com/${config.bucket}${canonicalKey}`,
    );
  }
  return new URL(
    `https://${config.bucket}.s3.${config.region}.amazonaws.com${canonicalKey}`,
  );
}

/** Build a pre-signed URL for a plain S3 request (PUT/GET). */
export function sigv4Presign(
  config: S3Config,
  method: "GET" | "PUT" | "DELETE",
  key: string,
  options: {
    expiresSeconds?: number;
    query?: Record<string, string>;
  } = {},
): string {
  const url = objectUrl(config, key);
  const now = new Date();
  const amzDate = `${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const expires = String(options.expiresSeconds ?? 900);

  const query: Record<string, string> = {
    ...(options.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": expires,
    "X-Amz-SignedHeaders": "host",
  };

  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v);
  }

  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(query),
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = crypto
    .createHmac("sha256", sigv4Key(config.secretAccessKey, dateStamp, config.region))
    .update(stringToSign)
    .digest("hex");

  url.searchParams.set("X-Amz-Signature", signature);
  return url.toString();
}

/** Sign a request with SigV4 headers (used for MPU control calls). */
async function sigv4Fetch(
  config: S3Config,
  method: "POST" | "DELETE",
  key: string,
  query: Record<string, string>,
  body?: string,
): Promise<Response> {
  const url = objectUrl(config, key);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const now = new Date();
  const amzDate = `${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const payloadHash = body
    ? crypto.createHash("sha256").update(body, "utf8").digest("hex")
    : "UNSIGNED-PAYLOAD";

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers)
    .sort()
    .map((h) => h.toLowerCase())
    .join(";");

  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(query),
    Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]}\n`)
      .join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = crypto
    .createHmac(
      "sha256",
      sigv4Key(config.secretAccessKey, dateStamp, config.region),
    )
    .update(stringToSign)
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, {
    method,
    headers: {
      ...headers,
      authorization,
      ...(body ? { "content-type": "application/xml" } : {}),
    },
    body,
  });
}

/* ------------------------------------------------------------------ *
 * Local filesystem driver
 * ------------------------------------------------------------------ */

const LOCAL_ROOT = process.env.VAULT_STORAGE_DIR
  ? path.resolve(process.env.VAULT_STORAGE_DIR)
  : path.join(process.cwd(), ".vault-store");

function safeLocalPath(key: string): string {
  if (!key || key.includes("..") || key.startsWith("/")) {
    throw new Error("Invalid storage key");
  }
  const target = path.join(LOCAL_ROOT, key);
  if (!target.startsWith(LOCAL_ROOT)) throw new Error("Invalid storage key");
  return target;
}

function localDriver(): ObjectDriver {
  return {
    name: "local",
    label: "Local vault (S3-compatible contract)",
    presignPut(key, opts = {}) {
      const isPart = typeof opts.partNumber === "number";
      return `/api/storage/${isPart ? "part" : "object"}?token=${signPayload({
        k: key,
        m: isPart ? "part-put" : "object-put",
        p: opts.partNumber,
        up: opts.uploadId,
        exp: Math.floor(Date.now() / 1000) + (opts.expiresSeconds ?? 3600),
      })}`;
    },
    presignGet(key, expiresSeconds = 3600) {
      return `/api/storage/object?token=${signPayload({
        k: key,
        m: "object-get",
        exp: Math.floor(Date.now() / 1000) + expiresSeconds,
      })}`;
    },
    async initMultipart() {
      const uploadId = crypto.randomUUID();
      await fsp.mkdir(path.join(LOCAL_ROOT, "mpu", uploadId), {
        recursive: true,
      });
      return uploadId;
    },
    async completeMultipart(_key, uploadId, parts) {
      const dir = path.join(LOCAL_ROOT, "mpu", uploadId);
      const target = safeLocalPath(_key);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const out = fs.createWriteStream(target);
      let storedBytes = 0;
      const hash = crypto.createHash("md5");
      for (const part of sorted) {
        const partPath = path.join(dir, `${part.partNumber}.part`);
        await new Promise<void>((resolve, reject) => {
          const rs = fs.createReadStream(partPath);
          rs.on("data", (chunk: string | Buffer) => {
            const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            storedBytes += buf.length;
            hash.update(buf);
          });
          rs.on("error", reject);
          rs.on("end", () => resolve());
          rs.pipe(out, { end: false });
        });
      }
      await new Promise<void>((resolve) => out.end(resolve));
      await fsp.rm(dir, { recursive: true, force: true });
      return {
        storedBytes,
        etag: hash.digest("hex"),
      };
    },
    async abortMultipart(_key, uploadId) {
      await fsp.rm(path.join(LOCAL_ROOT, "mpu", uploadId), {
        recursive: true,
        force: true,
      });
    },
    async putObject(key, body) {
      const target = safeLocalPath(key);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const nodeStream = Readable.fromWeb(
        body as unknown as import("node:stream/web").ReadableStream,
      );
      await fsp.writeFile(target, nodeStream);
      const stat = await fsp.stat(target);
      return stat.size;
    },
    async putPart(uploadId, partNumber, body) {
      const dir = path.join(LOCAL_ROOT, "mpu", uploadId);
      await fsp.mkdir(dir, { recursive: true });
      const target = path.join(dir, `${partNumber}.part`);
      const buffer = Buffer.from(await new Response(body).arrayBuffer());
      await fsp.writeFile(target, buffer);
      return {
        etag: crypto.createHash("md5").update(buffer).digest("hex"),
        size: buffer.length,
      };
    },
    async getObject(key, range) {
      const target = safeLocalPath(key);
      try {
        const stat = await fsp.stat(target);
        if (!stat.isFile()) return null;
        const start = range?.start ?? 0;
        const end = Math.min(range?.end ?? stat.size - 1, stat.size - 1);
        const nodeStream = fs.createReadStream(target, { start, end });
        return {
          stream: Readable.toWeb(
            nodeStream,
          ) as unknown as ReadableStream<Uint8Array>,
          size: end - start + 1,
        };
      } catch {
        return null;
      }
    },
    async deleteObject(key) {
      await fsp.rm(safeLocalPath(key), { force: true });
    },
    async statObject(key) {
      try {
        const stat = await fsp.stat(safeLocalPath(key));
        return stat.size;
      } catch {
        return null;
      }
    },
  };
}

function s3Driver(config: S3Config): ObjectDriver {
  return {
    name: "s3",
    label: `S3-compatible · ${config.bucket}`,
    presignPut(key, opts = {}) {
      const query: Record<string, string> = {};
      if (typeof opts.partNumber === "number") {
        query.partNumber = String(opts.partNumber);
        query.uploadId = String(opts.uploadId);
      }
      return sigv4Presign(config, "PUT", key, {
        expiresSeconds: opts.expiresSeconds ?? 3600,
        query,
      });
    },
    presignGet(key, expiresSeconds = 3600) {
      return sigv4Presign(config, "GET", key, { expiresSeconds });
    },
    async initMultipart(key) {
      const res = await sigv4Fetch(config, "POST", key, { uploads: "" });
      if (!res.ok) {
        throw new Error(`CreateMultipartUpload failed: ${res.status}`);
      }
      const xml = await res.text();
      const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
      if (!match) throw new Error("Malformed CreateMultipartUpload response");
      return match[1];
    },
    async completeMultipart(key, uploadId, parts) {
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      const xml = `<CompleteMultipartUpload>${sorted
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag.replace(/"/g, "")}</ETag></Part>`,
        )
        .join("")}</CompleteMultipartUpload>`;
      const res = await sigv4Fetch(config, "POST", key, { uploadId }, xml);
      if (!res.ok) {
        throw new Error(`CompleteMultipartUpload failed: ${res.status}`);
      }
      const storedBytes = sorted.reduce((sum, part) => sum + part.size, 0);
      return { storedBytes, etag: sorted.map((p) => p.etag).join("-") };
    },
    async abortMultipart(key, uploadId) {
      await sigv4Fetch(config, "DELETE", key, { uploadId });
    },
    async putObject(key, body) {
      const buffer = Buffer.from(await new Response(body).arrayBuffer());
      const url = sigv4Presign(config, "PUT", key, { expiresSeconds: 600 });
      const res = await fetch(url, { method: "PUT", body: buffer });
      if (!res.ok) throw new Error(`PutObject failed: ${res.status}`);
      return buffer.length;
    },
    async putPart() {
      // Parts are uploaded straight from the device to the bucket using
      // pre-signed URLs, so the API never sees the bytes.
      throw new Error("S3 driver streams parts directly to the bucket");
    },
    async getObject(key, range) {
      const url = sigv4Presign(config, "GET", key, { expiresSeconds: 600 });
      const res = await fetch(url, {
        headers: range ? { range: `bytes=${range.start}-${range.end}` } : {},
      });
      if (!res.ok || !res.body) return null;
      return {
        stream: res.body as ReadableStream<Uint8Array>,
        size: Number(res.headers.get("content-length") ?? 0),
      };
    },
    async deleteObject(key) {
      const res = await fetch(sigv4Presign(config, "DELETE", key), {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`DeleteObject failed: ${res.status}`);
      }
    },
    async statObject() {
      return null;
    },
  };
}

let cachedDriver: ObjectDriver | null = null;

export function storage(): ObjectDriver {
  if (cachedDriver) return cachedDriver;
  const {
    S3_BUCKET,
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
    S3_REGION,
    S3_ENDPOINT,
  } = process.env;
  if (S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
    cachedDriver = s3Driver({
      bucket: S3_BUCKET,
      region: S3_REGION ?? "auto",
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      endpoint: S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" || Boolean(S3_ENDPOINT),
    });
  } else {
    cachedDriver = localDriver();
  }
  return cachedDriver;
}

export function buildStorageKey(userId: string, suffix = "bin"): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `u/${userId}/${yyyy}/${mm}/${crypto.randomUUID()}.${suffix}`;
}
