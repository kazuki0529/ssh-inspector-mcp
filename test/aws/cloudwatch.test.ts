import { describe, expect, it, vi } from "vitest";

import type { RemoteCommandRunner } from "../../src/execution/executor.js";
import {
  CloudWatchCommandBuilder,
  getMetricDataInputSchema,
} from "../../src/aws/cloudwatch.js";
import { AwsExecutionError, executeAwsJson } from "../../src/aws/execute.js";

describe("CloudWatchCommandBuilder", () => {
  it("metric data queryをAWS field名のJSONへ変換する", () => {
    const builder = new CloudWatchCommandBuilder();
    const input = getMetricDataInputSchema.parse({
      region: "ap-northeast-1",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-01T01:00:00Z",
      queries: [
        {
          id: "cpu",
          metricStat: {
            metric: {
              namespace: "AWS/EC2",
              metricName: "CPUUtilization",
              dimensions: [{ name: "InstanceId", value: "i-123" }],
            },
            period: 300,
            stat: "Average",
          },
        },
      ],
    });

    const command = builder.getMetricData(input);
    const queryIndex = command.args.indexOf("--metric-data-queries");
    const queries = JSON.parse(command.args[queryIndex + 1] ?? "null") as unknown;

    expect(queries).toEqual([
      {
        Id: "cpu",
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: "AWS/EC2",
            MetricName: "CPUUtilization",
            Dimensions: [{ Name: "InstanceId", Value: "i-123" }],
          },
          Period: 300,
          Stat: "Average",
        },
      },
    ]);
  });

  it("31日超の時間範囲を許可する", () => {
    const input = {
      region: "ap-northeast-1",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-03-01T00:00:00Z",
      queries: [{ id: "m1", expression: "1" }],
    };

    expect(() => getMetricDataInputSchema.parse(input)).not.toThrow();
  });

  it("query方式の重複を拒否する", () => {
    const input = {
      region: "ap-northeast-1",
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-01-02T00:00:00Z",
      queries: [{ id: "m1", expression: "1", metricStat: { metric: { namespace: "N", metricName: "M" }, period: 60, stat: "Average" } }],
    };

    expect(() => getMetricDataInputSchema.parse(input)).toThrow();
  });
});

describe("executeAwsJson", () => {
  it("truncated JSONをparse前に拒否する", async () => {
    const runner: RemoteCommandRunner = {
      execute: vi.fn(() => Promise.resolve({
        stdout: "{",
        stderr: "",
        exitCode: 0,
        signal: null,
        truncated: true,
      })),
    };

    await expect(executeAwsJson(runner, { executable: "aws", args: [] })).rejects.toBeInstanceOf(
      AwsExecutionError,
    );
  });
});