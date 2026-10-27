import type { Readable } from "node:stream";

export interface StorageDriver {
  readonly name: string;
  /** Store a local file under `key` (keys are generated server-side only). */
  putFile(key: string, filePath: string, contentType: string): Promise<void>;
  putBuffer(key: string, body: Buffer, contentType: string): Promise<void>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /** Short-lived direct download URL, or null when downloads must be proxied. */
  signedDownloadUrl(key: string, filename: string, ttlSeconds: number): Promise<string | null>;
  check(): Promise<void>;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Build an object key from trusted identifiers; rejects traversal attempts. */
export function objectKey(...segments: string[]): string {
  for (const s of segments)
    if (!SAFE_SEGMENT.test(s) || s === "." || s === "..") throw new Error(`Unsafe storage key segment: ${s}`);
  return segments.join("/");
}
