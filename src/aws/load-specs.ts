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
        if (tool.timeoutMs > config.limits.operationTimeoutMs || tool.maxOutputBytes > config.limits.maxOutputBytes) {
          throw new AwsSpecLoadError(`AWS拡張tool ${tool.name} の上限がserver上限を超えています`);
        }
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