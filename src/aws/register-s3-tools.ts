import type { McpServer } from "@modelcontextprotocol/server";

import { executeTool } from "../tools/tool-result.js";
import type { S3Service } from "./s3.js";
import {
  getObjectTextInputSchema,
  headObjectInputSchema,
  listBucketsInputSchema,
  listObjectsInputSchema,
} from "./s3.js";

/** S3 metadata/data参照toolを登録します。 */
export function registerS3Tools(server: McpServer, service: S3Service): void {
  server.registerTool("aws_s3_list_buckets", { description: "設定で許可されたS3 bucket metadataだけを一覧します。", inputSchema: listBucketsInputSchema }, async (input) => executeTool(async () => service.listBuckets(input)));
  server.registerTool("aws_s3_list_objects", { description: "許可bucket/prefix内のS3 object metadataを一覧します。", inputSchema: listObjectsInputSchema }, async (input) => executeTool(async () => service.listObjects(input)));
  server.registerTool("aws_s3_head_object", { description: "許可bucket/prefix内のS3 object metadataを参照します。", inputSchema: headObjectInputSchema }, async (input) => executeTool(async () => service.headObject(input)));
  server.registerTool("aws_s3_get_object_text", { description: "本文参照が許可されたS3 text objectの指定byte rangeだけを取得します。", inputSchema: getObjectTextInputSchema }, async (input) => executeTool(async () => service.getObjectText(input)));
}