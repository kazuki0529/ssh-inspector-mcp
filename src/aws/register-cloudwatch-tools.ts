import type { McpServer } from "@modelcontextprotocol/server";

import type { CloudWatchService } from "./cloudwatch.js";
import {
  describeAlarmsInputSchema,
  getMetricDataInputSchema,
  listMetricsInputSchema,
} from "./cloudwatch.js";
import { executeTool } from "../tools/tool-result.js";

/**
 * CloudWatch参照toolをMCP serverへ登録します。
 *
 * @param server 登録先MCP server
 * @param service bounded CloudWatch service
 */
export function registerCloudWatchTools(server: McpServer, service: CloudWatchService): void {
  server.registerTool(
    "aws_cloudwatch_describe_alarms",
    {
      description: "CloudWatch alarm metadataを条件付きで参照します。",
      inputSchema: describeAlarmsInputSchema,
    },
    async (input) => executeTool(async () => service.describeAlarms(input)),
  );
  server.registerTool(
    "aws_cloudwatch_list_metrics",
    {
      description: "CloudWatch metric metadataを条件付きで参照します。",
      inputSchema: listMetricsInputSchema,
    },
    async (input) => executeTool(async () => service.listMetrics(input)),
  );
  server.registerTool(
    "aws_cloudwatch_get_metric_data",
    {
      description: "最大31日のCloudWatch metric dataをbounded queryで参照します。",
      inputSchema: getMetricDataInputSchema,
    },
    async (input) => executeTool(async () => service.getMetricData(input)),
  );
}