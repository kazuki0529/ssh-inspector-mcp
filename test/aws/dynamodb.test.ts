import { describe, expect, it, vi } from "vitest";

import { appConfigSchema } from "../../src/config/schema.js";
import type { RemoteCommandRunner } from "../../src/execution/executor.js";
import {
  DynamoDbAccessPolicy,
  DynamoDbCommandBuilder,
  DynamoDbService,
  queryInputSchema,
} from "../../src/aws/dynamodb.js";

const config = appConfigSchema.parse({
  ssh: {
    host: "rhel.example.internal",
    username: "inspector",
    hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    authentication: { method: "privateKey", privateKeyPath: "/tmp/key" },
  },
  access: { allowedListRoots: ["/var/log"] },
  aws: {
    allowedRegions: ["ap-northeast-1"],
    dynamodb: [
      { table: "StatusTable", indexes: ["ByService"], allowItemData: true },
      { table: "MetadataOnly", indexes: [], allowItemData: false },
    ],
  },
});

describe("DynamoDbAccessPolicy", () => {
  it("metadata許可、item data許可、index許可を分離する", () => {
    const policy = new DynamoDbAccessPolicy(config);

    expect(() => policy.assertMetadataAllowed("MetadataOnly")).not.toThrow();
    expect(() => policy.assertDataAllowed("MetadataOnly")).toThrow(/item data/);
    expect(() => policy.assertDataAllowed("StatusTable", "UnknownIndex")).toThrow(/index/);
  });
});

describe("DynamoDbCommandBuilder", () => {
  it("queryのAttributeValue mapsをJSON argvへ変換する", () => {
    const policy = new DynamoDbAccessPolicy(config);
    const builder = new DynamoDbCommandBuilder(config, policy);
    const input = queryInputSchema.parse({
      region: "ap-northeast-1",
      table: "StatusTable",
      index: "ByService",
      keyConditionExpression: "#service = :service",
      expressionAttributeNames: { "#service": "service" },
      expressionAttributeValues: { ":service": { S: "api" } },
      limit: 10,
    });

    const command = builder.query(input);
    const valueIndex = command.args.indexOf("--expression-attribute-values");

    expect(command.args[valueIndex + 1]).toBe(JSON.stringify({ ":service": { S: "api" } }));
    expect(command.args).toContain("--scan-index-forward");
  });

  it("AttributeValue内のfile参照を共通policyで拒否する", () => {
    const policy = new DynamoDbAccessPolicy(config);
    const builder = new DynamoDbCommandBuilder(config, policy);
    const input = queryInputSchema.parse({
      region: "ap-northeast-1",
      table: "StatusTable",
      keyConditionExpression: "pk = :pk",
      expressionAttributeValues: { ":pk": { S: "file:///etc/shadow" } },
    });

    expect(() => builder.query(input)).toThrow(/file参照/);
  });
});

describe("DynamoDbService", () => {
  it("list-tables結果をallowlistだけへfilterする", async () => {
    const policy = new DynamoDbAccessPolicy(config);
    const runner: RemoteCommandRunner = {
      execute: vi.fn(() => Promise.resolve({
        stdout: JSON.stringify({ TableNames: ["StatusTable", "SecretTable"] }),
        stderr: "",
        exitCode: 0,
        signal: null,
        truncated: false,
      })),
    };
    const service = new DynamoDbService(runner, new DynamoDbCommandBuilder(config, policy), policy);

    const response = await service.listTables({ region: "ap-northeast-1", limit: 100 });

    expect(response.result).toEqual({ TableNames: ["StatusTable"] });
  });
});