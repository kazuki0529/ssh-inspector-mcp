import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const expectedTools = [
  "aws_cloudformation_describe_stack_events",
  "aws_cloudformation_describe_stack_resource",
  "aws_cloudformation_describe_stacks",
  "aws_cloudformation_list_stack_resources",
  "aws_codepipeline_get_pipeline_execution",
  "aws_codepipeline_get_pipeline_state",
  "aws_codepipeline_list_action_executions",
  "aws_codepipeline_list_pipeline_executions",
  "aws_codepipeline_list_pipelines",
  "aws_cloudwatch_describe_alarms",
  "aws_cloudwatch_get_metric_data",
  "aws_cloudwatch_list_metrics",
  "aws_cloudwatch_logs_describe_log_groups",
  "aws_cloudwatch_logs_describe_log_streams",
  "aws_cloudwatch_logs_filter_log_events",
  "aws_cloudwatch_logs_get_log_events",
  "aws_dynamodb_describe_table",
  "aws_dynamodb_get_item",
  "aws_dynamodb_list_tables",
  "aws_dynamodb_query",
  "aws_s3_get_object_text",
  "aws_s3_head_object",
  "aws_s3_list_buckets",
  "aws_s3_list_objects",
  "ssh_find_files",
  "ssh_get_file_metadata",
  "ssh_health_check",
  "ssh_list_directory",
  "ssh_read_file_head",
  "ssh_read_file_range",
  "ssh_read_file_tail",
  "ssh_search_text",
  "ssh_system_info",
].sort();

const temporaryDirectory = await mkdtemp(join(tmpdir(), "ssh-inspector-mcp-"));
const configPath = join(temporaryDirectory, "config.json");
const config = {
  ssh: {
    host: "integration.invalid",
    username: "inspector",
    hostKeySha256: `SHA256:${"A".repeat(43)}`,
    authentication: { method: "privateKey", privateKeyPath: join(temporaryDirectory, "unused-key") },
  },
  access: { allowedListRoots: ["/var/log"] },
};

await writeFile(configPath, JSON.stringify(config), "utf8");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/ssh-inspector-mcp.mjs"), "--config", configPath],
  stderr: "pipe",
});
const client = new Client({ name: "ssh-inspector-integration", version: "1.0.0" });

try {
  await client.connect(transport);
  const response = await client.listTools();
  const actualTools = response.tools.map((tool) => tool.name).sort();

  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
    throw new Error(`MCP tool discoveryが一致しません: ${JSON.stringify(actualTools)}`);
  }

  const unsupportedKeywords = ["oneOf", "allOf", "anyOf"];
  const incompatibleSchemas = response.tools.flatMap((tool) =>
    unsupportedKeywords
      .filter((keyword) => Object.hasOwn(tool.inputSchema, keyword))
      .map((keyword) => `${tool.name}:${keyword}`),
  );
  if (incompatibleSchemas.length > 0) {
    throw new Error(`Kiro非互換のroot schema keywordがあります: ${incompatibleSchemas.join(", ")}`);
  }
} finally {
  await client.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
