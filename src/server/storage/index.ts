import { config } from "../config";
import { LocalStorage } from "./local";
import { S3Storage } from "./s3";
import type { StorageDriver } from "./types";

export { objectKey } from "./types";
export type { StorageDriver } from "./types";

let driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (!driver) {
    const c = config();
    driver =
      c.STORAGE_DRIVER === "s3"
        ? new S3Storage(c.S3_BUCKET!, c.S3_REGION!, c.S3_ENDPOINT, c.S3_FORCE_PATH_STYLE)
        : new LocalStorage(c.LOCAL_STORAGE_DIR);
  }
  return driver;
}

/** Test hook. */
export function resetStorage() {
  driver = null;
}
