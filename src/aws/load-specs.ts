import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AppConfig } from "../config/schema.js";
import { awsToolSpecFileSchema, type AwsToolSpec } from "./spec-schema.js";

/** AWS拡張spec読込失敗を表します。 */
export class AwsSpecLoadError extends Error {
  /**
   * spec内容を漏らさず読込失敗の文脈を保持します。
   *
   * @param message 利用者へ表示可能な理由
   * @param cause 元例外
   */
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AwsSpecLoadError";
  }
}

/**
 * 明示指定されたversioned JSONだけを読み込み、server上限より緩いtoolを拒否します。
 *
 * @param config 検証済み起動設定
 * @returns immutableな拡張tool一覧
 */
export async function loadAwsToolSpecs(config: AppConfig): Promise<readonly AwsToolSpec[]> {
  const tools: AwsToolSpec[] = [];

  for (const configuredPath of config.aws.extensionSpecPaths) {
    const path = resolve(configuredPath);
    try {
      const source = await readFile(path, "utf8");
      const file = awsToolSpecFileSchema.parse(JSON.parse(source) as unknown);

      for (const tool of file.tools) {
        if (!config.aws.allowedRegions.includes(tool.region)) {
          throw new AwsSpecLoadError(`AWS拡張tool ${tool.name} のregionがallowlistにありません`);
        }
        if (tool.timeoutMs > config.limits.operationTimeoutMs || tool.maxOutputBytes > config.limits.maxOutputBytes) {
          throw new AwsSpecLoadError(`AWS拡張tool ${tool.name} の上限がserver上限を超えています`);
        }
        validateResourcePolicy(tool, config);
        tools.push(tool);
      }
    } catch (error) {
      if (error instanceof AwsSpecLoadError) {
        throw error;
      }
      throw new AwsSpecLoadError(`AWS拡張specを読み込めません: ${path}`, error);
    }
  }

  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new AwsSpecLoadError("AWS拡張spec間でtool名が重複しています");
  }

  return Object.freeze(tools);
}

/**
 * 標準toolと同じS3/DynamoDB resource allowlistを拡張toolにも適用します。
 *
 * @param tool 検証済みtool spec
 * @param config 検証済み起動設定
 */
function validateResourcePolicy(tool: AwsToolSpec, config: AppConfig): void {
  if (tool.service === "s3api") {
    if (tool.operation === "list-buckets" || tool.parameters.some((parameter) => ["bucket", "key", "prefix"].includes(parameter.cliName))) {
      throw new AwsSpecLoadError(`S3拡張tool ${tool.name} はresourceを入力parameterにできません`);
    }
    const bucket = tool.fixedArgs.bucket;
    const rule = config.aws.s3.find((candidate) => candidate.bucket === bucket);
    if (!rule) {
      throw new AwsSpecLoadError(`S3拡張tool ${tool.name} の固定bucketがallowlistにありません`);
    }
    const keyOrPrefix = tool.fixedArgs.key ?? tool.fixedArgs.prefix;
    if (typeof keyOrPrefix === "string" && !rule.prefixes.some((prefix) => isWithinPrefix(keyOrPrefix, prefix))) {
      throw new AwsSpecLoadError(`S3拡張tool ${tool.name} の固定key/prefixがallowlistにありません`);
    }
    if (tool.operation === "get-object" && !rule.allowObjectContent) {
      throw new AwsSpecLoadError(`S3拡張tool ${tool.name} のobject本文参照が許可されていません`);
    }
  }

  if (tool.service === "dynamodb") {
    if (tool.operation === "list-tables" || tool.parameters.some((parameter) => ["table-name", "index-name"].includes(parameter.cliName))) {
      throw new AwsSpecLoadError(`DynamoDB拡張tool ${tool.name} はresourceを入力parameterにできません`);
    }
    const tableName = tool.fixedArgs["table-name"];
    const rule = config.aws.dynamodb.find((candidate) => candidate.table === tableName);
    if (!rule) {
      throw new AwsSpecLoadError(`DynamoDB拡張tool ${tool.name} の固定tableがallowlistにありません`);
    }
    const indexName = tool.fixedArgs["index-name"];
    if (typeof indexName === "string" && !rule.indexes.includes(indexName)) {
      throw new AwsSpecLoadError(`DynamoDB拡張tool ${tool.name} の固定indexがallowlistにありません`);
    }
    if (["batch-get-item", "get-item", "query", "scan"].includes(tool.operation) && !rule.allowItemData) {
      throw new AwsSpecLoadError(`DynamoDB拡張tool ${tool.name} のitem data参照が許可されていません`);
    }
  }
}

/**
 * S3 prefixのsegment境界を維持します。
 *
 * @param candidate 固定keyまたはprefix
 * @param allowedPrefix 設定済みprefix
 * @returns allowlist内ならtrue
 */
function isWithinPrefix(candidate: string, allowedPrefix: string): boolean {
  if (allowedPrefix === "") {
    return true;
  }
  const normalized = allowedPrefix.endsWith("/") ? allowedPrefix : `${allowedPrefix}/`;
  return candidate === allowedPrefix || candidate.startsWith(normalized);
}