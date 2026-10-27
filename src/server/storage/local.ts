import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { StorageDriver } from "./types";

/** Local filesystem storage for development and single-node installs. Downloads are proxied. */
export class LocalStorage implements StorageDriver {
  readonly name = "local";
  private root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error("Storage key escapes the storage root");
    return p;
  }

  async putFile(key: string, filePath: string, _contentType?: string) {
    const dest = this.resolve(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fsp.copyFile(filePath, dest);
    await fsp.chmod(dest, 0o600);
  }

  async putBuffer(key: string, body: Buffer, _contentType?: string) {
    const dest = this.resolve(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, body, { mode: 0o600 });
    await fsp.rename(tmp, dest); // atomic replace: retries never leave partial files
  }

  async getStream(key: string): Promise<Readable> {
    const p = this.resolve(key);
    await fsp.access(p);
    return fs.createReadStream(p);
  }

  async delete(key: string) {
    await fsp.rm(this.resolve(key), { force: true });
  }

  async signedDownloadUrl() {
    return null;
  }

  async check() {
    await fsp.mkdir(this.root, { recursive: true, mode: 0o700 });
    const probe = path.join(this.root, `.health-${process.pid}`);
    await fsp.writeFile(probe, "ok");
    await fsp.rm(probe, { force: true });
  }
}
