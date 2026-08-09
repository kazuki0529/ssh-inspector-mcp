import type { McpServer } from "@modelcontextprotocol/server";

import { executeTool } from "../tools/tool-result.js";
import type { DynamoDbService } from "./dynamodb.js";
import { describeTableInputSchema, getItemInputSchema, listTablesInputSchema, queryInputSchema } from "./dynamodb.js";

/** DynamoDB metadata/data参照toolを登録します。scanは公開しません。 */
export function registerDynamoDbTools(server: McpServer, service: DynamoDbService): void {
  server.registerTool("aws_dynamodb_list_tables", { description: "DynamoDB table名を一覧します。", inputSchema: listTablesInputSchema }, async (input) => executeTool(async () => service.listTables(input)));
  server.registerTool("aws_dynamodb_describe_table", { description: "指定したDynamoDB table metadataを参照します。", inputSchema: describeTableInputSchema }, async (input) => executeTool(async () => service.describeTable(input)));
  server.registerTool("aws_dynamodb_get_item", { description: "指定したDynamoDB tableから構造化keyで1件取得します。", inputSchema: getItemInputSchema }, async (input) => executeTool(async () => service.getItem(input)));
  server.registerTool("aws_dynamodb_query", { description: "指定したDynamoDB table/indexをbounded queryします。", inputSchema: queryInputSchema }, async (input) => executeTool(async () => service.query(input)));
}