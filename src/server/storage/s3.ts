import fs from "node:fs";
import fsp from "node:fs/promises";
import type { Readable } from "node:stream";
import type { StorageDriver } from "./types";

/**
 * S3-compatible private object storage. Objects are written with
 * server-side encryption (SSE-S3) and served only via short-lived presigned
 * URLs issued after server-side authorization.
 *
 * NOTE: implemented against the AWS SDK v3 API but not integration-tested in
 * the build environment (no S3 endpoint was available). Validate against your
 * bucket before production use (see docs/deployment.md).
 */
export class S3Storage implements StorageDriver {
  readonly name = "s3";
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client> | null = null;

  constructor(
    private bucket: string,
    private region: string,
    private endpoint?: string,
    private forcePathStyle = false,
  ) {}

  private async client() {
    if (!this.clientPromise)
      this.clientPromise = import("@aws-sdk/client-s3").then(
        ({ S3Client }) =>
          new S3Client({
            region: this.region,
            endpoint: this.endpoint || undefined,
            forcePathStyle: this.forcePathStyle,
          }),
      );
    return this.clientPromise;
  }

  async putFile(key: string, filePath: string, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { size } = await fsp.stat(filePath);
    await (
      await this.client()
    ).send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async putBuffer(key: string, body: Buffer, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (
      await this.client()
    ).send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async getStream(key: string): Promise<Readable> {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await this.client()).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async signedDownloadUrl(key: string, filename: string, ttlSeconds: number) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_");
    return getSignedUrl(
      await this.client(),
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async check() {
    const { HeadBucketCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}
