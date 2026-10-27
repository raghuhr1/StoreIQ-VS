/**
 * Structured JSON logger. Never pass credentials, tokens or raw RFID rows.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const REDACT = /pass(word)?|token|secret|cookie|authorization|session/i;

function threshold() {
  const l = (process.env.LOG_LEVEL ?? "info") as Level | "silent";
  return ORDER[l] ?? ORDER.info;
}

function redact(fields: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields))
    out[k] = REDACT.test(k) ? "[REDACTED]" : v instanceof Error ? { name: v.name, message: v.message } : v;
  return out;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...redact(fields) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
