import type { McpServer } from "@modelcontextprotocol/server";

import { executeTool } from "../tools/tool-result.js";
import type { CloudWatchLogsService } from "./cloudwatch-logs.js";
import {
  describeLogGroupsInputSchema,
  describeLogStreamsInputSchema,
  filterLogEventsInputSchema,
  getLogEventsInputSchema,
} from "./cloudwatch-logs.js";

/**
 * CloudWatch Logs metadata・event本文参照toolを登録します。
 *
 * @param server 登録先MCP server
 * @param service bounded CloudWatch Logs service
 */
export function registerCloudWatchLogsTools(
  server: McpServer,
  service: CloudWatchLogsService,
): void {
  server.registerTool(
    "aws_cloudwatch_logs_describe_log_groups",
    {
      description: "CloudWatch Logs log groupをprefixまたはpatternで最大50件検索します。",
      inputSchema: describeLogGroupsInputSchema,
    },
    async (input) => executeTool(async () => service.describeLogGroups(input)),
  );
  server.registerTool(
    "aws_cloudwatch_logs_describe_log_streams",
    {
      description: "指定log groupのCloudWatch Logs stream metadataを最大50件一覧します。",
      inputSchema: describeLogStreamsInputSchema,
    },
    async (input) => executeTool(async () => service.describeLogStreams(input)),
  );
  server.registerTool(
    "aws_cloudwatch_logs_filter_log_events",
    {
      description: "指定log groupのeventを最大24時間・100件で検索します。",
      inputSchema: filterLogEventsInputSchema,
    },
    async (input) => executeTool(async () => service.filterLogEvents(input)),
  );
  server.registerTool(
    "aws_cloudwatch_logs_get_log_events",
    {
      description: "指定した単一log streamからeventを最大24時間・100件取得します。",
      inputSchema: getLogEventsInputSchema,
    },
    async (input) => executeTool(async () => service.getLogEvents(input)),
  );
}