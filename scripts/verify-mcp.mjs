import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const expectedTools = [
  "aws_cloudwatch_describe_alarms",
  "aws_cloudwatch_get_metric_data",
  "aws_cloudwatch_list_metrics",
  "aws_dynamodb_describe_table",
  "aws_dynamodb_get_item",
  "aws_dynamodb_list_tables",
  "aws_dynamodb_query",
  "aws_s3_get_object_text",
  "aws_s3_head_object",
  "aws_s3_list_buckets",
  "aws_s3_list_objects",
  "ssh_find_files",
  "ssh_health_check",
  "ssh_list_directory",
  "ssh_read_file_head",
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
  args: [resolve("dist/ssh-inspector.mjs"), "--config", configPath],
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
} finally {
  await client.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}