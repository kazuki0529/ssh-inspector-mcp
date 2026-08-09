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
      inputSchema: z
        .object({
          root: z.string().min(1).max(4096).startsWith("/"),
          nameGlob: z.string().min(1).max(255).optional(),
          type: z.enum(["any", "directory", "file"]).default("any"),
          maxDepth: z.number().int().min(0).max(32).default(8),
          limit: z.number().int().min(1).max(config.limits.maxResults).default(100),
        })
        .strict(),
    },
    async (input) => executeTool(async () => dependencies.findFiles.find(input)),
  );

  server.registerTool(
    "ssh_search_text",
    {
      description: "許可read root内のtextを固定grep templateで検索します。literal検索が既定です。",
      inputSchema: z
        .object({
          root: z.string().min(1).max(4096).startsWith("/"),
          query: z.string().min(1).max(512),
          mode: z.enum(["literal", "extendedRegex"]).default("literal"),
          caseSensitive: z.boolean().default(true),
          includeGlob: z.string().min(1).max(255).optional(),
          limit: z.number().int().min(1).max(config.limits.maxResults).default(100),
        })
        .strict(),
    },
    async (input) => executeTool(async () => dependencies.searchText.search(input)),
  );

  const systemInfoInput = z.discriminatedUnion("kind", [
    z.object({ kind: z.enum(["filesystem", "kernel", "memory", "processes", "release", "uptime"]) }).strict(),
    z
      .object({
        kind: z.literal("package"),
        packageName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,127}$/),
      })
      .strict(),
    z
      .object({
        kind: z.literal("service"),
        unit: z.string().regex(/^[A-Za-z0-9_.@-]+$/),
      })
      .strict(),
  ]);

  server.registerTool(
    "ssh_system_info",
    {
      description: "RHEL release、kernel、uptime、filesystem、memory、process、package、許可serviceを参照します。",
      inputSchema: systemInfoInput,
    },
    async (input) => executeTool(async () => dependencies.systemInfo.inspect(input)),
  );
}