import { z } from "zod";

const parameterNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const cliNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);

const commonParameterFields = {
  name: parameterNameSchema,
  cliName: cliNameSchema,
  description: z.string().min(1).max(1024),
  required: z.boolean().default(false),
} as const;

const parameterSchema = z.discriminatedUnion("type", [
  z.object({ ...commonParameterFields, type: z.literal("string"), minLength: z.number().int().min(0).max(8192).default(0), maxLength: z.number().int().min(1).max(8192).default(1024), enum: z.array(z.string().max(1024)).min(1).max(100).optional() }).strict(),
  z.object({ ...commonParameterFields, type: z.literal("integer"), minimum: z.number().int().default(0), maximum: z.number().int().default(1_000_000) }).strict(),
  z.object({ ...commonParameterFields, type: z.literal("boolean") }).strict(),
  z.object({ ...commonParameterFields, type: z.literal("stringArray"), minItems: z.number().int().min(0).max(100).default(0), maxItems: z.number().int().min(1).max(100).default(20), itemMaxLength: z.number().int().min(1).max(8192).default(1024) }).strict(),
  z.object({ ...commonParameterFields, type: z.literal("jsonObject"), maxBytes: z.number().int().min(2).max(65_536).default(16_384) }).strict(),
]);

const fixedValueSchema = z.union([
  z.string().max(8192),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(8192)).max(100),
  z.record(z.string().max(255), z.unknown()).refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 65_536),
]);

/** 単一AWS拡張toolのschemaです。 */
export const awsToolSpecSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    description: z.string().min(1).max(1024),
    service: z.enum(["cloudwatch", "dynamodb", "ec2", "logs", "rds", "s3api"]),
    operation: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    region: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/),
    fixedArgs: z.record(cliNameSchema, fixedValueSchema).default({}),
    parameters: z.array(parameterSchema).max(64).default([]),
    timeoutMs: z.number().int().min(1_000).max(120_000),
    maxOutputBytes: z.number().int().min(1_024).max(10_485_760),
  })
  .strict()
  .superRefine((tool, context) => {
    const names = tool.parameters.map((parameter) => parameter.name);
    const cliNames = tool.parameters.map((parameter) => parameter.cliName);
    if (new Set(names).size !== names.length || new Set(cliNames).size !== cliNames.length) {
      context.addIssue({ code: "custom", path: ["parameters"], message: "parameter名は重複できません" });
    }
    if (cliNames.some((name) => Object.hasOwn(tool.fixedArgs, name))) {
      context.addIssue({ code: "custom", path: ["parameters"], message: "fixedArgsとparameterのCLI名が重複しています" });
    }
    if (!isReadOnlyOperation(tool.service, tool.operation)) {
      context.addIssue({ code: "custom", path: ["operation"], message: "read-only allowlist外のAWS operationです" });
    }
    if (tool.service === "dynamodb" && tool.operation === "scan") {
      const limit = tool.parameters.find((parameter) => parameter.cliName === "limit");
      if (limit?.type !== "integer" || !limit.required || limit.maximum > 100) {
        context.addIssue({ code: "custom", path: ["parameters"], message: "DynamoDB scanは最大100の必須limitが必要です" });
      }
    }
  });

/** versioned AWS拡張spec fileのschemaです。 */
export const awsToolSpecFileSchema = z
  .object({ version: z.literal(1), tools: z.array(awsToolSpecSchema).min(1).max(64) })
  .strict()
  .refine((file) => new Set(file.tools.map((tool) => tool.name)).size === file.tools.length, "tool名は重複できません");

/** 検証済みAWS拡張tool型です。 */
export type AwsToolSpec = z.infer<typeof awsToolSpecSchema>;

/**
 * service別の読取operation allowlistを適用します。
 *
 * @param service AWS CLI service
 * @param operation AWS CLI operation
 * @returns read-only subsetならtrue
 */
export function isReadOnlyOperation(service: AwsToolSpec["service"], operation: string): boolean {
  const prefixes: Record<AwsToolSpec["service"], readonly string[]> = {
    cloudwatch: ["describe-", "get-", "list-"],
    dynamodb: ["batch-get-", "describe-", "get-", "list-", "query", "scan"],
    ec2: ["describe-", "get-"],
    logs: ["describe-", "filter-", "get-", "list-"],
    rds: ["describe-", "list-"],
    s3api: ["get-", "head-", "list-"],
  };

  return prefixes[service].some((prefix) => operation === prefix || operation.startsWith(prefix));
}