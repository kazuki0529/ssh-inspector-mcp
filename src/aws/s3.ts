import { TextDecoder } from "node:util";

import { z } from "zod";

import type { AppConfig } from "../config/schema.js";
import type { RemoteCommandRunner } from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";
import { AwsPolicyError, buildAwsCommand } from "./build-argv.js";
import { executeAwsJson } from "./execute.js";

const bucketSchema = z.string().min(3).max(63);
const keySchema = z.string().min(1).max(1024).refine((value) => !value.includes("\0"));

/** S3 list-buckets入力schemaです。 */
export const listBucketsInputSchema = z.object({ region: z.string() }).strict();
/** S3 list-objects-v2入力schemaです。 */
export const listObjectsInputSchema = z
  .object({
    region: z.string(),
    bucket: bucketSchema,
    prefix: z.string().max(1024).default(""),
    delimiter: z.string().min(1).max(16).optional(),
    maxKeys: z.number().int().min(1).max(1_000).default(100),
    continuationToken: z.string().min(1).max(4096).optional(),
  })
  .strict();
/** S3 head-object入力schemaです。 */
export const headObjectInputSchema = z
  .object({
    region: z.string(),
    bucket: bucketSchema,
    key: keySchema,
    versionId: z.string().min(1).max(1024).optional(),
  })
  .strict();
/** S3 text object取得入力schemaです。 */
export const getObjectTextInputSchema = headObjectInputSchema
  .extend({
    startByte: z.number().int().min(0),
    maxBytes: z.number().int().min(1).max(1_048_576),
  })
  .strict();

/** S3 list buckets入力型です。 */
export type ListBucketsInput = z.infer<typeof listBucketsInputSchema>;
/** S3 list objects入力型です。 */
export type ListObjectsInput = z.infer<typeof listObjectsInputSchema>;
/** S3 head object入力型です。 */
export type HeadObjectInput = z.infer<typeof headObjectInputSchema>;
/** S3 get object text入力型です。 */
export type GetObjectTextInput = z.infer<typeof getObjectTextInputSchema>;

/**
 * S3入力を固定AWS CLI commandへ変換します。
 */
export class S3CommandBuilder {
  /**
   * bucket metadata一覧commandを生成します。
   *
   * @param input list buckets入力
   * @returns 固定command
   */
  public listBuckets(input: ListBucketsInput): RemoteCommand {
    return this.#build("list-buckets", input.region, {});
  }

  /**
  * 指定prefix内のobject一覧commandを生成します。
   *
   * @param input list objects入力
   * @returns 固定command
   */
  public listObjects(input: ListObjectsInput): RemoteCommand {
    return this.#build("list-objects-v2", input.region, {
      bucket: input.bucket,
      prefix: input.prefix,
      delimiter: input.delimiter,
      "max-keys": input.maxKeys,
      "continuation-token": input.continuationToken,
    });
  }

  /**
  * 指定objectのmetadata参照commandを生成します。
   *
   * @param input head object入力
   * @returns 固定command
   */
  public headObject(input: HeadObjectInput): RemoteCommand {
    return this.#build("head-object", input.region, {
      bucket: input.bucket,
      key: input.key,
      "version-id": input.versionId,
    });
  }

  /**
   * range指定したobject bytesをstdoutへ送る固定commandを生成します。
   *
   * @param input text取得入力
   * @param endByte inclusive range終端
   * @returns 固定command
   */
  public getObject(input: GetObjectTextInput, endByte: number): RemoteCommand {
    const command = this.#build("get-object", input.region, {
      bucket: input.bucket,
      key: input.key,
      "version-id": input.versionId,
      range: `bytes=${input.startByte}-${endByte}`,
    });

    return { ...command, args: [...command.args, "/dev/stdout"] };
  }

  /**
   * AWS共通policyを全S3 operationへ適用します。
   *
   * @param operation S3 API operation
   * @param region AWS region
   * @param parameters operation parameter
   * @returns 固定command
   */
  #build(operation: string, region: string, parameters: Parameters<typeof buildAwsCommand>[0]["parameters"]): RemoteCommand {
    return buildAwsCommand({
      service: "s3api",
      operation,
      region,
      parameters,
    });
  }
}

/**
 * S3 metadataとbounded text object参照を実行します。
 */
export class S3Service {
  readonly #runner: RemoteCommandRunner;
  readonly #builder: S3CommandBuilder;
  readonly #maxOutputBytes: number;

  /**
   * S3実行依存とoutput上限を固定します。
   *
   * @param runner bounded runner
   * @param builder S3 builder
   * @param config 検証済み設定
   */
  public constructor(
    runner: RemoteCommandRunner,
    builder: S3CommandBuilder,
    config: AppConfig,
  ) {
    this.#runner = runner;
    this.#builder = builder;
    this.#maxOutputBytes = config.limits.maxOutputBytes;
  }

  /**
  * IAMが返したbucket一覧を返します。
   *
   * @param input list buckets入力
  * @returns AWS JSON
   */
  public async listBuckets(input: ListBucketsInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.listBuckets(input)) };
  }

  /**
  * 指定prefix内のobject metadataを一覧します。
   *
   * @param input list objects入力
   * @returns AWS JSON
   */
  public async listObjects(input: ListObjectsInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.listObjects(input)) };
  }

  /**
  * 指定objectのmetadataを参照します。
   *
   * @param input head object入力
   * @returns AWS JSON
   */
  public async headObject(input: HeadObjectInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.headObject(input)) };
  }

  /**
   * content metadataを先に検査し、要求rangeだけをUTF-8 textとして返します。
   *
   * @param input text取得入力
   * @returns bounded object text
   */
  public async getObjectText(input: GetObjectTextInput): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
    if (input.maxBytes > this.#maxOutputBytes - 8_192) {
      throw new AwsPolicyError("maxBytesはserver出力上限から8192 bytes差し引いた値以下にしてください");
    }

    const metadata = await executeAwsJson(this.#runner, this.#builder.headObject(input));
    const head = z.object({ ContentLength: z.number().int().nonnegative(), ContentType: z.string().optional(), ContentEncoding: z.string().optional() }).passthrough().parse(metadata);
    assertTextContent(head.ContentType, head.ContentEncoding);

    const remaining = Math.max(0, head.ContentLength - input.startByte);
    const expectedBytes = Math.min(remaining, input.maxBytes);
    if (expectedBytes === 0) {
      return { text: "", bytesRead: 0, truncated: false };
    }

    const endByte = input.startByte + expectedBytes - 1;
    const result = await this.#runner.execute(this.#builder.getObject(input, endByte));
    if (result.exitCode !== 0) {
      throw new Error(`S3 get-objectが終了code ${String(result.exitCode)} で失敗しました: ${result.stderr}`);
    }

    const bytes = Buffer.from(result.stdout, "utf8").subarray(0, expectedBytes);
    if (bytes.length < expectedBytes) {
      throw new Error("S3 get-objectの出力が要求rangeより短いため拒否しました");
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, bytesRead: bytes.length, truncated: input.startByte + bytes.length < head.ContentLength };
  }
}

/**
 * 明示的なtext系content-typeと無圧縮UTF-8候補だけを許可します。
 *
 * @param contentType S3 metadata
 * @param contentEncoding S3 metadata
 */
function assertTextContent(contentType: string | undefined, contentEncoding: string | undefined): void {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const allowed = normalized?.startsWith("text/") === true || new Set([
    "application/json",
    "application/ld+json",
    "application/x-ndjson",
    "application/xml",
    "application/yaml",
    "application/octet-stream",
    "binary/octet-stream",
  ]).has(normalized ?? "");

  if (!allowed || contentEncoding !== undefined) {
    throw new AwsPolicyError("text content-typeかつ無圧縮のS3 objectだけを参照できます");
  }
}