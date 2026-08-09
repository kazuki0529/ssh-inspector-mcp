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
  server.registerTool("aws_s3_list_buckets", { description: "S3 bucket metadataを一覧します。", inputSchema: listBucketsInputSchema }, async (input) => executeTool(async () => service.listBuckets(input)));
  server.registerTool("aws_s3_list_objects", { description: "指定bucket/prefix内のS3 object metadataを一覧します。", inputSchema: listObjectsInputSchema }, async (input) => executeTool(async () => service.listObjects(input)));
  server.registerTool("aws_s3_head_object", { description: "指定したS3 objectのmetadataを参照します。", inputSchema: headObjectInputSchema }, async (input) => executeTool(async () => service.headObject(input)));
  server.registerTool("aws_s3_get_object_text", { description: "指定したS3 text objectのbyte rangeだけを取得します。", inputSchema: getObjectTextInputSchema }, async (input) => executeTool(async () => service.getObjectText(input)));
}