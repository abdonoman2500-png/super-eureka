/**
 * NimbusVault — Cloud vault schema (Drizzle ORM / PostgreSQL)
 *
 * Mirrors the reference architecture:
 *  - users        : accounts, 1 TB hard quota, wrapped zero-knowledge key material
 *  - sessions     : rotating refresh tokens (opaque, stored hashed)
 *  - folders      : virtual hierarchical folder tree
 *  - files        : encrypted object metadata (server never sees plaintext bytes)
 *  - uploadSessions : multi-part upload bookkeeping (pause / resume / abort)
 *  - deviceCredentials : biometric-capable device keys (ECDH P-256)
 *  - authChallenges  : single-use server challenges for device proof-of-possession
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    pinHash: varchar("pin_hash", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 120 }),
    // 1 TB = 1099511627776 bytes
    storageLimitBytes: bigint("storage_limit_bytes", { mode: "number" })
      .notNull()
      .default(1099511627776),
    storageUsedBytes: bigint("storage_used_bytes", { mode: "number" })
      .notNull()
      .default(0),
    // Zero-knowledge envelope encryption (client-side only values)
    keyWrapSalt: text("key_wrap_salt").notNull(),
    encryptedKeyBlob: text("encrypted_key_blob").notNull(),
    keyWrapIv: text("key_wrap_iv").notNull(),
    // App-lock brute force protection
    failedPinAttempts: integer("failed_pin_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    userAgent: varchar("user_agent", { length: 400 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
  ],
);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: varchar("name", { length: 255 }).notNull(),
    color: varchar("color", { length: 24 }).default("indigo"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("folders_user_parent_idx").on(table.userId, table.parentId),
    index("folders_parent_idx").on(table.parentId),
  ],
);

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id"),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull(),
    storedBytes: bigint("stored_bytes", { mode: "number" }).notNull().default(0),
    mimeType: varchar("mime_type", { length: 140 }).notNull(),
    s3StorageKey: text("s3_storage_key").notNull(),
    thumbnailKey: text("thumbnail_key"),
    encryption: varchar("encryption", { length: 40 })
      .notNull()
      .default("aes-256-gcm"),
    isFavorite: boolean("is_favorite").notNull().default(false),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("files_user_folder_idx").on(table.userId, table.folderId),
    index("files_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id"),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 140 }).notNull(),
    declaredBytes: bigint("declared_bytes", { mode: "number" }).notNull(),
    storedBytes: bigint("stored_bytes", { mode: "number" })
      .notNull()
      .default(0),
    storageKey: text("storage_key").notNull(),
    providerUploadId: text("provider_upload_id"),
    partSize: integer("part_size").notNull(),
    totalParts: integer("total_parts").notNull(),
    status: varchar("status", { length: 24 }).notNull().default("pending"),
    kind: varchar("kind", { length: 24 }).notNull().default("file"),
    parentFileId: uuid("parent_file_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("upload_sessions_user_idx").on(table.userId, table.status)],
);

export const deviceCredentials = pgTable(
  "device_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: varchar("credential_id", { length: 128 }).notNull(),
    label: varchar("label", { length: 160 }).notNull().default("This device"),
    // Exported ECDH P-256 public JWK ({ kty, crv, x, y })
    publicKeyJwk: jsonb("public_key_jwk").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("device_credentials_credential_unique").on(table.credentialId),
    index("device_credentials_user_idx").on(table.userId),
  ],
);

export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    credentialId: varchar("credential_id", { length: 128 }),
    // Serialized ephemeral ECDH private key (PKCS8 DER, base64url)
    ephemeralPrivateKey: text("ephemeral_private_key").notNull(),
    nonce: text("nonce").notNull(),
    purpose: varchar("purpose", { length: 32 }).notNull().default("biometric"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("auth_challenges_expires_idx").on(table.expiresAt)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    action: varchar("action", { length: 64 }).notNull(),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("audit_log_user_idx").on(table.userId, table.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Folder = typeof folders.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
