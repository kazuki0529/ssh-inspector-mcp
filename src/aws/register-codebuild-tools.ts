import type { McpServer } from "@modelcontextprotocol/server";

import { executeTool } from "../tools/tool-result.js";
import type { CodeBuildService } from "./codebuild.js";
import {
  batchGetBuildsInputSchema,
  batchGetProjectsInputSchema,
  listBuildsForProjectInputSchema,
  listProjectsInputSchema,
} from "./codebuild.js";

/**
 * CodeBuild診断toolをMCP serverへ登録します。
 *
 * @param server 登録先MCP server
 * @param service allow-field適用済みCodeBuild service
 */
export function registerCodeBuildTools(server: McpServer, service: CodeBuildService): void {
  server.registerTool("aws_codebuild_list_projects", { description: "CodeBuild project名をbounded一覧します。", inputSchema: listProjectsInputSchema }, async (input) => executeTool(async () => service.listProjects(input)));
  server.registerTool("aws_codebuild_batch_get_projects", { description: "CodeBuild project設定を秘密値を除外して最大100件参照します。", inputSchema: batchGetProjectsInputSchema }, async (input) => executeTool(async () => service.batchGetProjects(input)));
  server.registerTool("aws_codebuild_list_builds_for_project", { description: "指定projectのCodeBuild build IDをbounded一覧します。", inputSchema: listBuildsForProjectInputSchema }, async (input) => executeTool(async () => service.listBuildsForProject(input)));
  server.registerTool("aws_codebuild_batch_get_builds", { description: "CodeBuild buildのstatus、phase、CloudWatch Logs識別子を最大100件参照します。", inputSchema: batchGetBuildsInputSchema }, async (input) => executeTool(async () => service.batchGetBuilds(input)));
}