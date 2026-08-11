import type { RemoteCommand } from "../execution/render-command.js";

/** 固定builderが許可するAWS serviceです。 */
export type AllowedAwsService = "cloudwatch" | "codebuild" | "dynamodb" | "ec2" | "logs" | "rds" | "s3api";

/** AWS CLI parameterの安全な値型です。 */
export type AwsParameterValue = boolean | number | string | readonly string[] | object;

/** AWS CLI共通policy違反を表します。 */
export class AwsPolicyError extends Error {
  /**
   * 秘密値を含まないpolicy違反理由を保持します。
   *
   * @param message 拒否理由
   */
  public constructor(message: string) {
    super(message);
    this.name = "AwsPolicyError";
  }
}

/** AWS CLI command builderの入力です。 */
export interface BuildAwsCommandInput {
  service: AllowedAwsService;
  operation: string;
  region: string;
  parameters: Readonly<Record<string, AwsParameterValue | undefined>>;
}

const safeOperationPattern = /^[a-z][a-z0-9-]{0,63}$/;
const safeParameterPattern = /^[a-z][a-z0-9-]{0,63}$/;
const awsRegionPattern = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const forbiddenParameters = new Set([
  "cli-input-json",
  "cli-input-yaml",
  "debug",
  "endpoint-url",
  "no-paginate",
  "no-sign-request",
  "no-verify-ssl",
  "output",
  "profile",
  "query",
]);

/**
 * AWS CLIの共通安全optionを強制し、型付きparameterだけをargvへ変換します。
 *
 * @param input service・operation・region・parameter
 * @returns `/usr/bin/aws` 固定command
 */
export function buildAwsCommand(input: BuildAwsCommandInput): RemoteCommand {
  if (!awsRegionPattern.test(input.region)) {
    throw new AwsPolicyError("AWS region形式が不正です");
  }
  if (!safeOperationPattern.test(input.operation)) {
    throw new AwsPolicyError("AWS operation名が不正です");
  }

  const args = [
    input.service,
    input.operation,
    "--region",
    input.region,
    "--output",
    "json",
    "--no-cli-pager",
    "--no-cli-auto-prompt",
    "--no-paginate",
  ];

  for (const [name, value] of Object.entries(input.parameters).sort(([left], [right]) => left.localeCompare(right))) {
    if (value === undefined) {
      continue;
    }
    if (!safeParameterPattern.test(name) || forbiddenParameters.has(name)) {
      throw new AwsPolicyError("許可されていないAWS CLI parameterです");
    }

    assertNoExternalReference(value);
    appendParameter(args, name, value);
  }

  return { executable: "/usr/bin/aws", args };
}

/**
 * parameter値をAWS CLIが曖昧なく解釈できるargvへ変換します。
 *
 * @param args 追記先argv
 * @param name parameter名
 * @param value 安全性検査済み値
 */
function appendParameter(args: string[], name: string, value: AwsParameterValue): void {
  const option = `--${name}`;

  if (typeof value === "boolean") {
    args.push(value ? option : `--no-${name}`);
    return;
  }
  if (typeof value === "number" || typeof value === "string") {
    args.push(option, String(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((item): item is string => typeof item === "string")) {
      args.push(option, ...value);
      return;
    }
    args.push(option, JSON.stringify(value));
    return;
  }

  args.push(option, JSON.stringify(value));
}

/**
 * AWS CLIのfile/fileb参照がSSH先の任意file読取へ転用されることを防ぎます。
 *
 * @param value parameter値
 */
function assertNoExternalReference(value: AwsParameterValue): void {
  const inspect = (candidate: unknown): void => {
    if (typeof candidate === "string" && /^(?:file|fileb):\/\//u.test(candidate)) {
      throw new AwsPolicyError("AWS parameterでfile参照は使用できません");
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(inspect);
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      Object.values(candidate).forEach(inspect);
    }
  };

  inspect(value);
}