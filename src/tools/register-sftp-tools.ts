import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppConfig } from "../config/schema.js";
import type { SftpInspector } from "./sftp-inspector.js";
import { executeTool } from "./tool-result.js";

/**
 * SSH/SFTP参照toolをMCP serverへ登録します。
 *
 * @param server 登録先MCP server
 * @param inspector bounded SFTP service
 * @param config tool input上限の根拠となる検証済み設定
 */
export function registerSftpTools(
  server: McpServer,
  inspector: SftpInspector,
  config: AppConfig,
): void {
  server.registerTool(
    "ssh_health_check",
    {
      description: "固定SSHホストへの接続とSFTP subsystemの疎通を確認します。",
      inputSchema: z.object({}).strict(),
    },
    async () => executeTool(async () => inspector.healthCheck()),
  );

  const listInput = z
    .object({
      path: z.string().min(1).max(4096).startsWith("/"),
      includeHidden: z.boolean().default(false),
      limit: z.number().int().min(1).max(config.limits.maxResults).default(100),
    })
    .strict();

  server.registerTool(
    "ssh_list_directory",
    {
      description: "許可root内のdirectory metadataを上限件数まで一覧します。file本文は返しません。",
      inputSchema: listInput,
    },
    async ({ path, includeHidden, limit }) =>
      executeTool(async () => inspector.listDirectory(path, includeHidden, limit)),
  );

  server.registerTool(
    "ssh_get_file_metadata",
    {
      description: "許可list root内のcanonical path、type、size、mtime、modeを本文なしで返します。",
      inputSchema: z.object({ path: z.string().min(1).max(4096).startsWith("/") }).strict(),
    },
    async ({ path }) => executeTool(async () => inspector.getFileMetadata(path)),
  );

  const readInput = z
    .object({
      path: z.string().min(1).max(4096).startsWith("/"),
      lines: z.number().int().min(1).max(config.limits.maxReadLines).default(100),
    })
    .strict();

  server.registerTool(
    "ssh_read_file_head",
    {
      description: "許可root内のUTF-8 text file先頭をline/byte上限内で参照します。",
      inputSchema: readInput,
    },
    async ({ path, lines }) => executeTool(async () => inspector.readHead(path, lines)),
  );

  server.registerTool(
    "ssh_read_file_tail",
    {
      description: "許可root内のUTF-8 text file末尾をline/byte上限内で参照します。",
      inputSchema: readInput,
    },
    async ({ path, lines }) => executeTool(async () => inspector.readTail(path, lines)),
  );

  server.registerTool(
    "ssh_read_file_range",
    {
      description: "許可root内のUTF-8 text fileをbounded scanし、1始まりの指定line範囲を返します。",
      inputSchema: z
        .object({
          path: z.string().min(1).max(4096).startsWith("/"),
          startLine: z.number().int().min(1).max(1_000_000),
          lines: z.number().int().min(1).max(config.limits.maxReadLines).default(100),
        })
        .strict(),
    },
    async ({ path, startLine, lines }) => executeTool(async () => inspector.readRange(path, startLine, lines)),
  );
}