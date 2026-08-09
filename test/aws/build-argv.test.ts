import { describe, expect, it } from "vitest";

import {
  AwsPolicyError,
  buildAwsCommand,
} from "../../src/aws/build-argv.js";

describe("buildAwsCommand", () => {
  it("共通安全optionとsort済みparameterを強制する", () => {
    const command = buildAwsCommand({
      service: "cloudwatch",
      operation: "list-metrics",
      region: "ap-northeast-1",
      parameters: {
        namespace: "AWS/EC2",
        "max-items": 25,
      },
    });

    expect(command).toEqual({
      executable: "/usr/bin/aws",
      args: [
        "cloudwatch",
        "list-metrics",
        "--region",
        "ap-northeast-1",
        "--output",
        "json",
        "--no-cli-pager",
        "--no-cli-auto-prompt",
        "--no-paginate",
        "--max-items",
        "25",
        "--namespace",
        "AWS/EC2",
      ],
    });
  });

  it("不正なregion形式と危険optionを拒否する", () => {
    expect(() =>
      buildAwsCommand({
        service: "cloudwatch",
        operation: "list-metrics",
        region: "not-a-region",
        parameters: {},
      }),
    ).toThrow(/region形式/);
    expect(() =>
      buildAwsCommand({
        service: "cloudwatch",
        operation: "list-metrics",
        region: "ap-northeast-1",
        parameters: { "endpoint-url": "https://attacker.example" },
      }),
    ).toThrow(AwsPolicyError);
  });

  it("nested object内のfile参照も拒否する", () => {
    expect(() =>
      buildAwsCommand({
        service: "cloudwatch",
        operation: "get-metric-data",
        region: "ap-northeast-1",
        parameters: {
          "metric-data-queries": [{ Id: "m1", Expression: "file:///etc/shadow" }],
        },
      }),
    ).toThrow(/file参照/);
  });
});