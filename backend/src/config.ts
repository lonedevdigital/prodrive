import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const rootEnvPath = resolve(process.cwd(), "..", ".env");
if (existsSync(rootEnvPath)) {
  loadEnv({ path: rootEnvPath });
} else {
  loadEnv();
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function numberFromEnv(
  name: string,
  fallback: number,
  minValue = 1
): number {
  const raw = optional(name);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    throw new Error(
      `Invalid env var ${name}: must be a number >= ${minValue}`
    );
  }

  return parsed;
}

const r2AccountId = required("R2_ACCOUNT_ID");
const r2Bucket = optional("R2_BUCKET") ?? optional("R2_BUCKET_NAME");

if (!r2Bucket) {
  throw new Error("Missing required env var: R2_BUCKET (or R2_BUCKET_NAME)");
}

const r2Endpoint = `https://${r2AccountId}.r2.cloudflarestorage.com`;
const publicShareBaseUrl = optional("PUBLIC_SHARE_BASE_URL")?.replace(/\/+$/, "");
const uploadMaxFileSizeMb = numberFromEnv("UPLOAD_MAX_FILE_SIZE_MB", 5120);
const uploadRequestTimeoutMs = numberFromEnv(
  "UPLOAD_REQUEST_TIMEOUT_MS",
  30 * 60 * 1000
);
const r2MultipartPartSizeMb = numberFromEnv("R2_MULTIPART_PART_SIZE_MB", 16, 5);
const r2MultipartQueueSize = numberFromEnv("R2_MULTIPART_QUEUE_SIZE", 4);

export const appConfig = {
  port: Number(process.env.PORT ?? "4000"),
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173",
  jwtSecret: required("JWT_SECRET"),
  databaseUrl: required("DATABASE_URL"),
  r2: {
    accountId: r2AccountId,
    endpoint: r2Endpoint,
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    bucket: r2Bucket
  },
  publicShareBaseUrl,
  upload: {
    maxFileSizeBytes: uploadMaxFileSizeMb * 1024 * 1024,
    requestTimeoutMs: uploadRequestTimeoutMs
  },
  r2Upload: {
    multipartPartSizeBytes: r2MultipartPartSizeMb * 1024 * 1024,
    multipartQueueSize: r2MultipartQueueSize
  }
};
