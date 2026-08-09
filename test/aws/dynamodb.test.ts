import { describe, expect, it, vi } from "vitest";

import type { RemoteCommandRunner } from "../../src/execution/executor.js";
import {
  DynamoDbCommandBuilder,
  DynamoDbService,
  queryInputSchema,
} from "../../src/aws/dynamodb.js";

describe("DynamoDbCommandBuilder", () => {
  it("queryのAttributeValue mapsをJSON argvへ変換する", () => {
    const builder = new DynamoDbCommandBuilder();
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
    const builder = new DynamoDbCommandBuilder();
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
  it("list-tables結果をIAMの応答どおり返す", async () => {
    const runner: RemoteCommandRunner = {
      execute: vi.fn(() => Promise.resolve({
        stdout: JSON.stringify({ TableNames: ["StatusTable", "SecretTable"] }),
        stderr: "",
        exitCode: 0,
        signal: null,
        truncated: false,
      })),
    };
    const service = new DynamoDbService(runner, new DynamoDbCommandBuilder());

    const response = await service.listTables({ region: "ap-northeast-1", limit: 100 });

    expect(response.result).toEqual({ TableNames: ["StatusTable", "SecretTable"] });
  });
});