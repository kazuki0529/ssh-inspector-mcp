import { z } from "zod";

const absoluteRemotePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .startsWith("/")
  .refine((value) => !value.includes("\0"), "パスにNUL文字は使用できません");

const environmentVariableNameSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "環境変数名が不正です");

const privateKeyAuthenticationSchema = z
  .object({
    method: z.literal("privateKey"),
    privateKeyPath: z.string().min(1).max(4096),
    passphraseEnv: environmentVariableNameSchema.optional(),
  })
  .strict();

const passwordAuthenticationSchema = z
  .object({
    method: z.literal("password"),
    passwordEnv: environmentVariableNameSchema,
  })
  .strict();

const s3AccessRuleSchema = z
  .object({
    bucket: z.string().min(3).max(63),
    prefixes: z.array(z.string().max(1024)).min(1).max(32),
    allowObjectContent: z.boolean().default(false),
  })
  .strict();

const dynamodbAccessRuleSchema = z
  .object({
    table: z.string().min(3).max(255),
    indexes: z.array(z.string().min(1).max(255)).max(32).default([]),
    allowItemData: z.boolean().default(false),
  })
  .strict();

/**
 * MCPサーバーが信頼してよい起動設定を定義します。
 *
 * 危険な全パス参照は、リスク承認を同時に指定しない限り拒否します。
 */
export const appConfigSchema = z
  .object({
    ssh: z
      .object({
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535).default(22),
        username: z.string().min(1).max(64),
        hostKeySha256: z
          .string()
          .regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "SSHホスト鍵fingerprintが不正です"),
        authentication: z.discriminatedUnion("method", [
          privateKeyAuthenticationSchema,
          passwordAuthenticationSchema,
        ]),
        readyTimeoutMs: z.number().int().min(1_000).max(60_000).default(20_000),
      })
      .strict(),
    access: z
      .object({
        allowedListRoots: z.array(absoluteRemotePathSchema).max(64).default([]),
        allowedReadRoots: z.array(absoluteRemotePathSchema).max(64).default([]),
        allowAllReadablePaths: z.boolean().default(false),
        acknowledgeBroadReadRisk: z.boolean().default(false),
        allowedSystemdUnits: z
          .array(z.string().regex(/^[A-Za-z0-9_.@-]+$/))
          .max(128)
          .default([]),
      })
      .strict(),
    limits: z
      .object({
        operationTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
        maxOutputBytes: z.number().int().min(1_024).max(10_485_760).default(1_048_576),
        maxConcurrentOperations: z.number().int().min(1).max(16).default(4),
        maxResults: z.number().int().min(1).max(5_000).default(500),
        maxReadLines: z.number().int().min(1).max(10_000).default(500),
      })
      .strict()
      .prefault({}),
    aws: z
      .object({
        allowedRegions: z.array(z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/)).max(32).default([]),
        s3: z.array(s3AccessRuleSchema).max(128).default([]),
        dynamodb: z.array(dynamodbAccessRuleSchema).max(128).default([]),
        extensionSpecPaths: z.array(z.string().min(1).max(4096)).max(32).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.access.allowAllReadablePaths && !config.access.acknowledgeBroadReadRisk) {
      context.addIssue({
        code: "custom",
        path: ["access", "acknowledgeBroadReadRisk"],
        message: "全可読範囲を許可するにはリスク承認が必要です",
      });
    }

    // 許可範囲なしの起動は、意図しない全体公開への変更を誘発しやすいため拒否します。
    if (
      !config.access.allowAllReadablePaths &&
      config.access.allowedListRoots.length === 0 &&
      config.access.allowedReadRoots.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["access"],
        message: "少なくとも1つの参照許可rootが必要です",
      });
    }
  });

/** 検証済み起動設定の型です。 */
export type AppConfig = z.infer<typeof appConfigSchema>;