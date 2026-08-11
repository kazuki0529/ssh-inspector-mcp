import type { McpServer } from "@modelcontextprotocol/server";

import { executeTool } from "../tools/tool-result.js";
import type { CloudFormationService } from "./cloudformation.js";
import { describeStackEventsInputSchema, describeStackResourceInputSchema, describeStacksInputSchema, listStackResourcesInputSchema } from "./cloudformation.js";

/** CloudFormationのbounded診断toolsを登録します。 */
export function registerCloudFormationTools(server: McpServer, service: CloudFormationService): void {
  server.registerTool("aws_cloudformation_describe_stacks", { description: "CloudFormation stack statusを秘密fieldなしで最大100件参照します。", inputSchema: describeStacksInputSchema }, async (input) => executeTool(async () => service.describeStacks(input)));
  server.registerTool("aws_cloudformation_describe_stack_events", { description: "CloudFormation stack eventsをstatus、logical resource、時間で絞り込みます。", inputSchema: describeStackEventsInputSchema }, async (input) => executeTool(async () => service.describeStackEvents(input)));
  server.registerTool("aws_cloudformation_list_stack_resources", { description: "CloudFormation stack resourcesを最大100件参照します。", inputSchema: listStackResourcesInputSchema }, async (input) => executeTool(async () => service.listStackResources(input)));
  server.registerTool("aws_cloudformation_describe_stack_resource", { description: "CloudFormation stackの単一logical resource状態を参照します。", inputSchema: describeStackResourceInputSchema }, async (input) => executeTool(async () => service.describeStackResource(input)));
}