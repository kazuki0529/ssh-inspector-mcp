import type { McpServer } from "@modelcontextprotocol/server";

import { executeTool } from "../tools/tool-result.js";
import type { CodePipelineService } from "./codepipeline.js";
import {
  getPipelineExecutionInputSchema,
  getPipelineStateInputSchema,
  listActionExecutionsInputSchema,
  listPipelineExecutionsInputSchema,
  listPipelinesInputSchema,
} from "./codepipeline.js";

/**
 * CodePipeline診断toolをMCP serverへ登録します。
 *
 * @param server 登録先MCP server
 * @param service allow-field適用済みCodePipeline service
 */
export function registerCodePipelineTools(server: McpServer, service: CodePipelineService): void {
  server.registerTool("aws_codepipeline_list_pipelines", { description: "CodePipeline pipeline metadataをbounded一覧します。", inputSchema: listPipelinesInputSchema }, async (input) => executeTool(async () => service.listPipelines(input)));
  server.registerTool("aws_codepipeline_get_pipeline_state", { description: "CodePipelineのstage/action stateを参照します。", inputSchema: getPipelineStateInputSchema }, async (input) => executeTool(async () => service.getPipelineState(input)));
  server.registerTool("aws_codepipeline_list_pipeline_executions", { description: "CodePipeline executionをlatest、failed、all modeでbounded一覧します。", inputSchema: listPipelineExecutionsInputSchema }, async (input) => executeTool(async () => service.listPipelineExecutions(input)));
  server.registerTool("aws_codepipeline_get_pipeline_execution", { description: "指定したCodePipeline executionの診断情報を参照します。", inputSchema: getPipelineExecutionInputSchema }, async (input) => executeTool(async () => service.getPipelineExecution(input)));
  server.registerTool("aws_codepipeline_list_action_executions", { description: "CodePipeline action executionのstatus、error、外部execution IDをbounded一覧します。", inputSchema: listActionExecutionsInputSchema }, async (input) => executeTool(async () => service.listActionExecutions(input)));
}