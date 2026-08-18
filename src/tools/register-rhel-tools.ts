import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppConfig } from "../config/schema.js";
import type { FindFilesService } from "./find-files.js";
import type { SearchTextService } from "./search-text.js";
import type { SystemInfoService } from "./system-info.js";
import { executeTool } from "./tool-result.js";

/** RHEL command tool登録に必要なserviceです。 */
export interface RhelToolDependencies {
  findFiles: FindFilesService;
  searchText: SearchTextService;
  systemInfo: SystemInfoService;
}

/**
 * find・grep・限定system情報toolをMCP serverへ登録します。
 *
 * @param server 登録先MCP server
 * @param dependencies bounded RHEL services
 * @param config input上限の根拠となる検証済み設定
 */
export function registerRhelTools(
  server: McpServer,
  dependencies: RhelToolDependencies,
  config: AppConfig,
): void {
  server.registerTool(
    "ssh_find_files",
    {
      description: "許可list root内を固定find templateで検索します。symlinkは追跡しません。",
      inputSchema: createFindFilesInputSchema(config.limits.maxResults),
    },
    async (input) => executeTool(async () => dependencies.findFiles.find(input)),
  );

  server.registerTool(
    "ssh_search_text",
    {
      description: "許可read root内の通常・gzip・bzip2・xz textを固定grep templateで検索します。literal検索が既定です。",
      inputSchema: createSearchTextInputSchema(config.limits.maxResults),
    },
    async (input) => executeTool(async () => dependencies.searchText.search(input)),
  );

  const systemInfoInput = z
    .object({
      kind: z.enum(["filesystem", "kernel", "memory", "processes", "release", "uptime", "package", "service"]),
      packageName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,127}$/).optional(),
      unit: z.string().regex(/^[A-Za-z0-9_.@-]+$/).optional(),
    })
    .strict()
    .superRefine((input, context) => {
      if ((input.kind === "package") !== (input.packageName !== undefined)) {
        context.addIssue({ code: "custom", path: ["packageName"], message: "package指定時だけpackageNameが必要です" });
      }
      if ((input.kind === "service") !== (input.unit !== undefined)) {
        context.addIssue({ code: "custom", path: ["unit"], message: "service指定時だけunitが必要です" });
      }
    });

  server.registerTool(
    "ssh_system_info",
    {
      description: "RHEL release、kernel、uptime、filesystem、memory、process、package、許可serviceを参照します。",
      inputSchema: systemInfoInput,
    },
    async (input) => executeTool(async () => {
      if (input.kind === "package" && input.packageName !== undefined) {
        return dependencies.systemInfo.inspect({ kind: input.kind, packageName: input.packageName });
      }
      if (input.kind === "service" && input.unit !== undefined) {
        return dependencies.systemInfo.inspect({ kind: input.kind, unit: input.unit });
      }
      if (input.kind !== "package" && input.kind !== "service") {
        return dependencies.systemInfo.inspect({ kind: input.kind });
      }
      throw new Error("system情報入力の必須parameterがありません");
    }),
  );
}

/**
 * `ssh_find_files`のbounded input schemaを生成します。
 *
 * @param maxResults server全体の最大結果件数
 * @returns find tool input schema
 */
export function createFindFilesInputSchema(maxResults: number) {
  return z
    .object({
      root: z.string().min(1).max(4096).startsWith("/"),
      nameGlob: z.string().min(1).max(255).optional(),
      caseInsensitiveName: z.boolean().default(false),
      type: z.enum(["any", "directory", "file"]).default("any"),
      modifiedAfter: z.iso.datetime({ offset: true }).optional(),
      modifiedBefore: z.iso.datetime({ offset: true }).optional(),
      minSizeBytes: z.number().int().min(0).max(1_099_511_627_776).optional(),
      maxSizeBytes: z.number().int().min(0).max(1_099_511_627_776).optional(),
      excludePathGlobs: z.array(z.string().min(1).max(4096)).max(20).default([]),
      maxDepth: z.number().int().min(0).max(32).default(8),
      limit: z.number().int().min(1).max(maxResults).default(Math.min(100, maxResults)),
    })
    .strict()
    .superRefine(validateBoundedRange);
}

/**
 * `ssh_search_text`のbounded input schemaを生成します。
 *
 * @param maxResults server全体の最大結果件数
 * @returns text search tool input schema
 */
export function createSearchTextInputSchema(maxResults: number) {
  return z
    .object({
      root: z.string().min(1).max(4096).startsWith("/"),
      query: z.string().min(1).max(512),
      mode: z.enum(["literal", "extendedRegex"]).default("literal"),
      caseSensitive: z.boolean().default(true),
      compression: z.enum(["none", "gzip", "bzip2", "xz"]).default("none"),
      includeGlob: z.string().min(1).max(255).optional(),
      excludeGlobs: z.array(z.string().min(1).max(4096)).max(20).default([]),
      contextBefore: z.number().int().min(0).default(0),
      contextAfter: z.number().int().min(0).default(0),
      maxDepth: z.number().int().min(0).max(32).default(8),
      modifiedAfter: z.iso.datetime({ offset: true }).optional(),
      modifiedBefore: z.iso.datetime({ offset: true }).optional(),
      filesWithMatchesOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(maxResults).default(Math.min(100, maxResults)),
    })
    .strict()
    .superRefine((input, context) => {
      validateBoundedRange(input, context);
      if (input.filesWithMatchesOnly && (input.contextBefore > 0 || input.contextAfter > 0)) {
        context.addIssue({ code: "custom", path: ["filesWithMatchesOnly"], message: "file名だけを返す場合はcontextを指定できません" });
      }
    });
}

/**
 * 日時・sizeの下限と上限が逆転していないことを保証します。
 *
 * @param input 任意のbounded range入力
 * @param context Zod検証context
 */
function validateBoundedRange(
  input: { modifiedAfter?: string | undefined; modifiedBefore?: string | undefined; minSizeBytes?: number | undefined; maxSizeBytes?: number | undefined },
  context: z.RefinementCtx,
): void {
  if (input.modifiedAfter !== undefined && input.modifiedBefore !== undefined && new Date(input.modifiedAfter).getTime() >= new Date(input.modifiedBefore).getTime()) {
    context.addIssue({ code: "custom", path: ["modifiedBefore"], message: "modifiedBeforeはmodifiedAfterより後である必要があります" });
  }
  if (input.minSizeBytes !== undefined && input.maxSizeBytes !== undefined && input.minSizeBytes > input.maxSizeBytes) {
    context.addIssue({ code: "custom", path: ["maxSizeBytes"], message: "maxSizeBytesはminSizeBytes以上である必要があります" });
  }
}