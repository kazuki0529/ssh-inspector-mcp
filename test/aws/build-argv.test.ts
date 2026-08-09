import { describe, expect, it } from "vitest";

import {
  AwsPolicyError,
  buildAwsCommand,
} from "../../src/aws/build-argv.js";

const allowedRegions = new Set(["ap-northeast-1"]);

describe("buildAwsCommand", () => {
  it("共通安全optionとsort済みparameterを強制する", () => {
    const command = buildAwsCommand({
      service: "cloudwatch",
      operation: "list-metrics",
      region: "ap-northeast-1",
      allowedRegions,
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

  it("allowlist外regionと危険optionを拒否する", () => {
    expect(() =>
      buildAwsCommand({
        service: "cloudwatch",
        operation: "list-metrics",
        region: "us-east-1",
        allowedRegions,
        parameters: {},
      }),
    ).toThrow(/allowlist/);
    expect(() =>
      buildAwsCommand({
        service: "cloudwatch",
        operation: "list-metrics",
        region: "ap-northeast-1",
        allowedRegions,
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
        allowedRegions,
        parameters: {
          "metric-data-queries": [{ Id: "m1", Expression: "file:///etc/shadow" }],
        },
      }),
    ).toThrow(/file参照/);
  });
});