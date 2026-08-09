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

interface S3Rule {
  prefixes: readonly string[];
  allowObjectContent: boolean;
}

/**
 * bucket/prefix単位のmetadata・data参照policyを保持します。
 */
export class S3AccessPolicy {
  readonly #rules: ReadonlyMap<string, S3Rule>;

  /**
   * 検証済み設定からimmutableなbucket ruleを構築します。
   *
   * @param config 検証済み起動設定
   */
  public constructor(config: AppConfig) {
    this.#rules = new Map(config.aws.s3.map((rule) => [rule.bucket, rule]));
  }

  /** 設定で公開を許可されたbucket名一覧です。 */
  public get allowedBuckets(): ReadonlySet<string> {
    return new Set(this.#rules.keys());
  }

  /**
   * metadata参照対象がbucket/prefix allowlist内であることを保証します。
   *
   * @param bucket bucket名
   * @param keyOrPrefix object keyまたはprefix
   */
  public assertMetadataAllowed(bucket: string, keyOrPrefix: string): void {
    const rule = this.#rules.get(bucket);
    if (!rule || !rule.prefixes.some((prefix) => isWithinS3Prefix(keyOrPrefix, prefix))) {
      throw new AwsPolicyError("S3 bucket/prefixがallowlistにありません");
    }
  }

  /**
   * 本文取得が明示許可されたbucket/prefix内であることを保証します。
   *
   * @param bucket bucket名
   * @param key object key
   */
  public assertContentAllowed(bucket: string, key: string): void {
    this.assertMetadataAllowed(bucket, key);
    if (!this.#rules.get(bucket)?.allowObjectContent) {
      throw new AwsPolicyError("S3 object本文の参照が許可されていません");
    }
  }
}

/**
 * S3 prefix境界を保ち、隣接名への誤許可を防ぎます。
 *
 * @param candidate keyまたは検索prefix
 * @param allowedPrefix 設定済みprefix
 * @returns 許可prefix自身または子孫ならtrue
 */
export function isWithinS3Prefix(candidate: string, allowedPrefix: string): boolean {
  if (allowedPrefix === "") {
    return true;
  }
  const normalized = allowedPrefix.endsWith("/") ? allowedPrefix : `${allowedPrefix}/`;
  return candidate === allowedPrefix || candidate.startsWith(normalized);
}

/**
 * S3入力を固定AWS CLI commandへ変換します。
 */
export class S3CommandBuilder {
  readonly #regions: ReadonlySet<string>;
  readonly #policy: S3AccessPolicy;

  /**
   * regionとbucket/prefix policyを固定します。
   *
   * @param config 検証済み設定
   * @param policy bucket/prefix policy
   */
  public constructor(config: AppConfig, policy: S3AccessPolicy) {
    this.#regions = new Set(config.aws.allowedRegions);
    this.#policy = policy;
  }

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
   * 許可prefix内のobject一覧commandを生成します。
   *
   * @param input list objects入力
   * @returns 固定command
   */
  public listObjects(input: ListObjectsInput): RemoteCommand {
    this.#policy.assertMetadataAllowed(input.bucket, input.prefix);
    return this.#build("list-objects-v2", input.region, {
      bucket: input.bucket,
      prefix: input.prefix,
      delimiter: input.delimiter,
      "max-keys": input.maxKeys,
      "continuation-token": input.continuationToken,
    });
  }

  /**
   * 許可objectのmetadata参照commandを生成します。
   *
   * @param input head object入力
   * @returns 固定command
   */
  public headObject(input: HeadObjectInput): RemoteCommand {
    this.#policy.assertMetadataAllowed(input.bucket, input.key);
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
    this.#policy.assertContentAllowed(input.bucket, input.key);
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
      allowedRegions: this.#regions,
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
  readonly #policy: S3AccessPolicy;
  readonly #maxOutputBytes: number;

  /**
   * S3実行依存とoutput上限を固定します。
   *
   * @param runner bounded runner
   * @param builder S3 builder
   * @param policy S3 policy
   * @param config 検証済み設定
   */
  public constructor(
    runner: RemoteCommandRunner,
    builder: S3CommandBuilder,
    policy: S3AccessPolicy,
    config: AppConfig,
  ) {
    this.#runner = runner;
    this.#builder = builder;
    this.#policy = policy;
    this.#maxOutputBytes = config.limits.maxOutputBytes;
  }

  /**
   * 設定bucketだけに絞った一覧を返します。
   *
   * @param input list buckets入力
   * @returns 許可bucketだけのAWS JSON
   */
  public async listBuckets(input: ListBucketsInput): Promise<{ result: unknown }> {
    const raw = await executeAwsJson(this.#runner, this.#builder.listBuckets(input));
    const parsed = z.object({ Buckets: z.array(z.object({ Name: z.string() }).passthrough()).default([]) }).passthrough().parse(raw);

    return {
      result: { ...parsed, Buckets: parsed.Buckets.filter((bucket) => this.#policy.allowedBuckets.has(bucket.Name)) },
    };
  }

  /**
   * 許可prefix内のobject metadataを一覧します。
   *
   * @param input list objects入力
   * @returns AWS JSON
   */
  public async listObjects(input: ListObjectsInput): Promise<{ result: unknown }> {
    return { result: await executeAwsJson(this.#runner, this.#builder.listObjects(input)) };
  }

  /**
   * 許可objectのmetadataを参照します。
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
    this.#policy.assertContentAllowed(input.bucket, input.key);
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
  ]).has(normalized ?? "");

  if (!allowed || contentEncoding !== undefined) {
    throw new AwsPolicyError("text content-typeかつ無圧縮のS3 objectだけを参照できます");
  }
}