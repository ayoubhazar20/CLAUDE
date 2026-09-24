import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../env";

/**
 * Storage abstraction for PDFs, attachments, logos and signature assets.
 * Business logic only sees `StorageDriver`; local disk and S3-compatible
 * object storage are interchangeable via STORAGE_DRIVER.
 */
export interface StorageDriver {
  readonly name: string;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-zA-Z0-9/_.-]+$/;
function assertKey(key: string) {
  if (!KEY_PATTERN.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid storage key");
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = "local";
  constructor(private readonly root: string) {}
  private resolve(key: string) {
    assertKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return full;
  }
  async put(key: string, data: Buffer) {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data, { mode: 0o600 });
  }
  async get(key: string) {
    return fs.readFile(this.resolve(key));
  }
  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
}

export class S3StorageDriver implements StorageDriver {
  readonly name = "s3";
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client> | null = null;
  constructor(private readonly config: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {}
  private async client() {
    this.clientPromise ??= import("@aws-sdk/client-s3").then(
      ({ S3Client }) =>
        new S3Client({
          region: this.config.region || "auto",
          endpoint: this.config.endpoint || undefined,
          forcePathStyle: Boolean(this.config.endpoint),
          credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
        }),
    );
    return this.clientPromise;
  }
  async put(key: string, data: Buffer, contentType: string) {
    assertKey(key);
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: "AES256" }));
  }
  async get(key: string) {
    assertKey(key);
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await this.client()).send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error("Empty object");
    return Buffer.from(bytes);
  }
  async delete(key: string) {
    assertKey(key);
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}

let driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (driver) return driver;
  const e = env();
  driver =
    e.STORAGE_DRIVER === "s3"
      ? new S3StorageDriver({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION, bucket: e.S3_BUCKET, accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY })
      : new LocalStorageDriver(path.resolve(e.STORAGE_LOCAL_DIR));
  return driver;
}

export function setStorageDriver(custom: StorageDriver) {
  driver = custom;
}
