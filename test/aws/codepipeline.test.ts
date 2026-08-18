import { describe, expect, it, vi } from "vitest";

import type { RemoteCommandRunner } from "../../src/execution/executor.js";
import {
  CodePipelineCommandBuilder,
  CodePipelineService,
  listActionExecutionsInputSchema,
  listPipelineExecutionsInputSchema,
} from "../../src/aws/codepipeline.js";

const executionId = "123e4567-e89b-12d3-a456-426614174000";

describe("CodePipelineCommandBuilder", () => {
  it("action execution filterを構造化JSON parameterへ変換する", () => {
    const builder = new CodePipelineCommandBuilder();
    const command = builder.listActionExecutions(listActionExecutionsInputSchema.parse({
      region: "ap-northeast-1",
      pipeline: "release-pipeline",
      executionId,
      limit: 25,
    }));

    expect(command.executable).toBe("aws");
    expect(command.args.slice(0, 2)).toEqual(["codepipeline", "list-action-executions"]);
    expect(command.args).toContain("--no-paginate");
    const filterIndex = command.args.indexOf("--filter");
    expect(JSON.parse(command.args[filterIndex + 1] ?? "null")).toEqual({ pipelineExecutionId: executionId });
  });

  it("latest modeではAWS取得件数も1件に制限する", () => {
    const builder = new CodePipelineCommandBuilder();
    const command = builder.listPipelineExecutions(listPipelineExecutionsInputSchema.parse({
      region: "ap-northeast-1",
      pipeline: "release-pipeline",
      mode: "latest",
      limit: 100,
    }));

    const maxResultsIndex = command.args.indexOf("--max-results");
    expect(command.args[maxResultsIndex + 1]).toBe("1");
  });
});

describe("CodePipelineService", () => {
  it("failed modeで失敗executionだけを返す", async () => {
    const service = new CodePipelineService(runnerFor({
      pipelineExecutionSummaries: [
        { pipelineExecutionId: executionId, status: "Failed", statusSummary: "deploy failed", secret: "drop" },
        { pipelineExecutionId: "223e4567-e89b-12d3-a456-426614174000", status: "Succeeded" },
      ],
      nextToken: "next",
    }), new CodePipelineCommandBuilder());

    await expect(service.listPipelineExecutions(listPipelineExecutionsInputSchema.parse({
      region: "ap-northeast-1",
      pipeline: "release-pipeline",
      mode: "failed",
      limit: 20,
    }))).resolves.toEqual({
      pipelineExecutionSummaries: [{
        pipelineExecutionId: executionId,
        status: "Failed",
        statusSummary: "deploy failed",
      }],
      nextToken: "next",
    });
  });

  it("action結果からconfiguration、artifact、変数、URL、tokenを除外する", async () => {
    const service = new CodePipelineService(runnerFor({
      actionExecutionDetails: [{
        pipelineExecutionId: executionId,
        actionExecutionId: "action-1",
        stageName: "Build",
        actionName: "CodeBuild",
        status: "Failed",
        input: {
          actionTypeId: { category: "Build", owner: "AWS", provider: "CodeBuild", version: "1" },
          configuration: { EnvironmentVariables: "SECRET=value" },
          inputArtifacts: [{ s3location: { bucket: "private", key: "source.zip" } }],
        },
        output: {
          executionResult: {
            externalExecutionId: "build-project:build-id",
            externalExecutionSummary: "build failed",
            externalExecutionUrl: "https://signed.example/token",
          },
          errorDetails: { code: "JobFailed", message: "build failed" },
          outputVariables: { TOKEN: "secret" },
          outputArtifacts: [{ s3location: { bucket: "private", key: "output.zip" } }],
        },
      }],
      nextToken: "next",
    }), new CodePipelineCommandBuilder());

    await expect(service.listActionExecutions(listActionExecutionsInputSchema.parse({
      region: "ap-northeast-1",
      pipeline: "release-pipeline",
      executionId,
      limit: 10,
    }))).resolves.toEqual({
      actionExecutionDetails: [{
        pipelineExecutionId: executionId,
        actionExecutionId: "action-1",
        stageName: "Build",
        actionName: "CodeBuild",
        status: "Failed",
        input: { actionTypeId: { category: "Build", owner: "AWS", provider: "CodeBuild", version: "1" } },
        output: {
          executionResult: { externalExecutionId: "build-project:build-id", externalExecutionSummary: "build failed" },
          errorDetails: { code: "JobFailed", message: "build failed" },
        },
      }],
      nextToken: "next",
    });
  });
});

function runnerFor(json: unknown): RemoteCommandRunner {
  return {
    execute: vi.fn(() => Promise.resolve({
      stdout: JSON.stringify(json),
      stderr: "",
      exitCode: 0,
      signal: null,
      truncated: false,
    })),
  };
}