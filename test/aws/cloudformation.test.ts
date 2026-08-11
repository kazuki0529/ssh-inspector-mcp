import { describe, expect, it, vi } from "vitest";

import { CloudFormationCommandBuilder, CloudFormationService, describeStackEventsInputSchema, describeStacksInputSchema } from "../../src/aws/cloudformation.js";
import { AwsExecutionError } from "../../src/aws/execute.js";
import type { CommandExecutionResult, RemoteCommandRunner } from "../../src/execution/executor.js";

const result = (stdout: string, exitCode = 0): CommandExecutionResult => ({
  stdout,
  stderr: exitCode === 0 ? "" : "AccessDenied",
  exitCode,
  signal: null,
  truncated: false,
});

describe("CloudFormationCommandBuilder", () => {
  it("stack一覧を固定cloudformation argvへ変換する", () => {
    const input = describeStacksInputSchema.parse({ region: "ap-northeast-1", stackName: "application", limit: 25 });
    const command = new CloudFormationCommandBuilder().describeStacks(input);

    expect(command.args.slice(0, 2)).toEqual(["cloudformation", "describe-stacks"]);
    expect(command.args).toContain("--stack-name");
    expect(command.args).toContain("--max-items");
  });

  it("逆転したevent時間範囲を拒否する", () => {
    expect(() => describeStackEventsInputSchema.parse({
      region: "ap-northeast-1",
      stackName: "application",
      startTime: "2026-08-11T01:00:00Z",
      endTime: "2026-08-11T00:00:00Z",
    })).toThrow(/endTime/);
  });
});

describe("CloudFormationService", () => {
  it("stack結果からParameters、Outputs、Tagsを除去してnextTokenを保持する", async () => {
    const runner: RemoteCommandRunner = {
      execute: vi.fn(() => Promise.resolve(result(JSON.stringify({
        Stacks: [{
          StackId: "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/application/id",
          StackName: "application",
          StackStatus: "UPDATE_ROLLBACK_COMPLETE",
          StackStatusReason: "Resource update cancelled",
          CreationTime: "2026-08-11T00:00:00Z",
          Parameters: [{ ParameterKey: "Password", ParameterValue: "secret" }],
          Outputs: [{ OutputKey: "Token", OutputValue: "secret" }],
          Tags: [{ Key: "Secret", Value: "secret" }],
        }],
        NextToken: "next-page",
      })))),
    };
    const service = new CloudFormationService(runner, new CloudFormationCommandBuilder());

    const response = await service.describeStacks({ region: "ap-northeast-1", stackName: "application", limit: 10 });
    const shaped = response.result as { Stacks: unknown[]; NextToken: string };

    expect(shaped.NextToken).toBe("next-page");
    expect(shaped.Stacks[0]).toMatchObject({ StackName: "application", StackStatus: "UPDATE_ROLLBACK_COMPLETE" });
    expect(shaped.Stacks[0]).not.toHaveProperty("Parameters");
    expect(shaped.Stacks[0]).not.toHaveProperty("Outputs");
    expect(shaped.Stacks[0]).not.toHaveProperty("Tags");
  });

  it("eventをstatus、logical ID、時間でfilterする", async () => {
    const runner: RemoteCommandRunner = {
      execute: vi.fn(() => Promise.resolve(result(JSON.stringify({
        StackEvents: [
          { EventId: "1", LogicalResourceId: "Api", ResourceStatus: "CREATE_FAILED", ResourceStatusReason: "failed", Timestamp: "2026-08-11T00:30:00Z" },
          { EventId: "2", LogicalResourceId: "Api", ResourceStatus: "CREATE_COMPLETE", Timestamp: "2026-08-11T00:20:00Z" },
          { EventId: "3", LogicalResourceId: "Other", ResourceStatus: "CREATE_FAILED", Timestamp: "2026-08-11T00:30:00Z" },
        ],
      })))),
    };
    const service = new CloudFormationService(runner, new CloudFormationCommandBuilder());
    const input = describeStackEventsInputSchema.parse({
      region: "ap-northeast-1",
      stackName: "application",
      resourceStatus: "CREATE_FAILED",
      logicalResourceId: "Api",
      startTime: "2026-08-11T00:00:00Z",
      endTime: "2026-08-11T01:00:00Z",
    });

    const response = await service.describeStackEvents(input);
    const shaped = response.result as { StackEvents: Array<{ EventId: string }> };

    expect(shaped.StackEvents.map((event) => event.EventId)).toEqual(["1"]);
  });

  it("AWS非zero終了を構造化errorとして拒否する", async () => {
    const runner: RemoteCommandRunner = { execute: vi.fn(() => Promise.resolve(result("", 254))) };
    const service = new CloudFormationService(runner, new CloudFormationCommandBuilder());

    await expect(service.describeStacks({ region: "ap-northeast-1", limit: 10 })).rejects.toBeInstanceOf(AwsExecutionError);
  });
});