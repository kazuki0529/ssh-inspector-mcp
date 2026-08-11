import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadAwsToolSpecs } from "../../src/aws/load-specs.js";
import { awsToolSpecFileSchema } from "../../src/aws/spec-schema.js";
import { appConfigSchema } from "../../src/config/schema.js";

const tool = {
  name: "aws_ec2_describe_instances_compact",
  description: "EC2 instance metadataを限定条件で参照します。",
  service: "ec2",
  operation: "describe-instances",
  region: "ap-northeast-1",
  fixedArgs: {},
  parameters: [
    {
      name: "instanceIds",
      cliName: "instance-ids",
      description: "対象instance ID",
      type: "stringArray",
      required: true,
      minItems: 1,
      maxItems: 20,
      itemMaxLength: 32,
    },
  ],
  timeoutMs: 10_000,
  maxOutputBytes: 65_536,
};

describe("awsToolSpecFileSchema", () => {
  it("read-only describe operationを受理しwrite operationを拒否する", () => {
    expect(() => awsToolSpecFileSchema.parse({ version: 1, tools: [tool] })).not.toThrow();
    expect(() => awsToolSpecFileSchema.parse({ version: 1, tools: [{ ...tool, operation: "run-instances" }] })).toThrow(/read-only/);
  });

  it("DynamoDB scanに最大100の必須limitを要求する", () => {
    const scanTool = {
      ...tool,
      name: "aws_dynamodb_bounded_scan",
      service: "dynamodb",
      operation: "scan",
      parameters: [{ name: "limit", cliName: "limit", description: "最大件数", type: "integer", required: false, minimum: 1, maximum: 100 }],
    };

    expect(() => awsToolSpecFileSchema.parse({ version: 1, tools: [scanTool] })).toThrow(/必須limit/);
  });

  it("secret shapingを迂回するCodePipeline extensionを拒否する", () => {
    expect(() => awsToolSpecFileSchema.parse({
      version: 1,
      tools: [{ ...tool, service: "codepipeline", operation: "list-action-executions" }],
    })).toThrow();
  });
});

describe("loadAwsToolSpecs", () => {
  it("server上限を超えるspecを拒否する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ssh-inspector-spec-"));
    const specPath = join(directory, "tools.json");
    await writeFile(specPath, JSON.stringify({ version: 1, tools: [tool] }), "utf8");
    const config = appConfigSchema.parse({
      ssh: {
        host: "rhel.example.internal",
        username: "inspector",
        hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        authentication: { method: "privateKey", privateKeyPath: "/tmp/key" },
      },
      access: { allowedListRoots: ["/var/log"] },
      limits: { operationTimeoutMs: 5_000, maxOutputBytes: 32_768 },
      aws: { extensionSpecPaths: [specPath] },
    });

    await expect(loadAwsToolSpecs(config)).rejects.toThrow(/server上限/);
  });

  it("S3 resourceを入力parameterにするspecをIAM認可前提で受理する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ssh-inspector-spec-"));
    const specPath = join(directory, "tools.json");
    const s3Tool = {
      ...tool,
      name: "aws_s3_dynamic_head",
      service: "s3api",
      operation: "head-object",
      fixedArgs: { key: "logs/app.log" },
      parameters: [{ name: "bucket", cliName: "bucket", description: "bucket", type: "string", required: true, minLength: 3, maxLength: 63 }],
    };
    await writeFile(specPath, JSON.stringify({ version: 1, tools: [s3Tool] }), "utf8");
    const config = appConfigSchema.parse({
      ssh: {
        host: "rhel.example.internal",
        username: "inspector",
        hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        authentication: { method: "privateKey", privateKeyPath: "/tmp/key" },
      },
      access: { allowedListRoots: ["/var/log"] },
      aws: { extensionSpecPaths: [specPath] },
    });

    await expect(loadAwsToolSpecs(config)).resolves.toHaveLength(1);
  });
});