import { describe, expect, it } from "vitest";

import {
  CloudWatchLogsCommandBuilder,
  describeLogStreamsInputSchema,
  filterLogEventsInputSchema,
  getLogEventsInputSchema,
} from "../../src/aws/cloudwatch-logs.js";

describe("CloudWatchLogsCommandBuilder", () => {
  it("任意log groupのfilter条件とISO時刻を固定argvへ変換する", () => {
    const builder = new CloudWatchLogsCommandBuilder();
    const input = filterLogEventsInputSchema.parse({
      region: "ap-northeast-1",
      logGroupName: "/aws/lambda/application",
      logStreamNamePrefix: "2026/08/09/",
      startTime: "2026-08-09T00:00:00Z",
      endTime: "2026-08-09T01:00:00Z",
      filterPattern: "ERROR",
      limit: 50,
    });

    const command = builder.filterLogEvents(input);

    expect(command.executable).toBe("/usr/bin/aws");
    expect(command.args.slice(0, 2)).toEqual(["logs", "filter-log-events"]);
    expect(command.args).toContain("/aws/lambda/application");
    expect(command.args).toContain(String(new Date("2026-08-09T00:00:00Z").getTime()));
    expect(command.args).toContain(String(new Date("2026-08-09T01:00:00Z").getTime()));
  });

  it("単一stream取得を最大100件に制限する", () => {
    expect(() =>
      getLogEventsInputSchema.parse({
        region: "ap-northeast-1",
        logGroupName: "/aws/ecs/application",
        logStreamName: "service/task",
        limit: 101,
      }),
    ).toThrow();
  });

  it("24時間超の検索とstream selectorの同時指定を拒否する", () => {
    expect(() =>
      filterLogEventsInputSchema.parse({
        region: "ap-northeast-1",
        logGroupName: "/aws/lambda/application",
        startTime: "2026-08-08T00:00:00Z",
        endTime: "2026-08-09T00:00:01Z",
      }),
    ).toThrow(/24時間/);
    expect(() =>
      filterLogEventsInputSchema.parse({
        region: "ap-northeast-1",
        logGroupName: "/aws/lambda/application",
        logStreamNames: ["stream-1"],
        logStreamNamePrefix: "stream-",
      }),
    ).toThrow(/同時指定/);
  });

  it("stream prefix指定時にLastEventTime順を拒否する", () => {
    expect(() =>
      describeLogStreamsInputSchema.parse({
        region: "ap-northeast-1",
        logGroupName: "/aws/lambda/application",
        logStreamNamePrefix: "2026/08/09/",
        orderBy: "LastEventTime",
      }),
    ).toThrow(/LogStreamName/);
  });
});