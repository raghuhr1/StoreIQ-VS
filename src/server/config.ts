import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  SESSION_TTL_HOURS: z.coerce
    .number()
    .min(1)
    .max(24 * 30)
    .default(12),
  SESSION_IDLE_MINUTES: z.coerce
    .number()
    .min(5)
    .max(24 * 60)
    .default(120),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_STORAGE_DIR: z.string().default("./storage-data"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().min(10).max(900).default(60),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .min(1024)
    .default(200 * 1024 * 1024),
  MAX_ROWS_PER_JOB: z.coerce.number().min(1).default(1_000_000),
  MAX_STORED_ROW_ERRORS: z.coerce.number().min(0).default(5000),
  JOB_TIMEOUT_SECONDS: z.coerce.number().min(30).default(1800),
  RETENTION_UPLOAD_FILES_DAYS: z.coerce.number().min(0).default(30),
  RETENTION_RAW_OBSERVATIONS_DAYS: z.coerce.number().min(0).default(30),
  LOGIN_RATE_LIMIT_PER_15MIN: z.coerce.number().min(1).default(10),
  API_WRITE_RATE_LIMIT_PER_MIN: z.coerce.number().min(1).default(120),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().min(100).default(2000),
  WORKER_CONCURRENCY: z.coerce.number().min(1).max(16).default(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

/** Validated configuration. Read lazily so tests and scripts can set env first. */
export function config(): AppConfig {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid configuration: ${issues}`);
    }
    if (parsed.data.STORAGE_DRIVER === "s3" && (!parsed.data.S3_BUCKET || !parsed.data.S3_REGION))
      throw new Error("Invalid configuration: S3_BUCKET and S3_REGION are required when STORAGE_DRIVER=s3");
    cached = parsed.data;
  }
  return cached;
}

export const isProduction = () => process.env.NODE_ENV === "production";
