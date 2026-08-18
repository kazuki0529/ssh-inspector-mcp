import { describe, expect, it, vi } from "vitest";

import type { RemoteCommandRunner } from "../../src/execution/executor.js";
import {
  batchGetBuildsInputSchema,
  batchGetProjectsInputSchema,
  CodeBuildCommandBuilder,
  CodeBuildService,
} from "../../src/aws/codebuild.js";

const buildId = "release-project:123e4567-e89b-12d3-a456-426614174000";

describe("CodeBuildCommandBuilder", () => {
  it("build ID配列を固定AWS argvへ変換する", () => {
    const builder = new CodeBuildCommandBuilder();
    const command = builder.batchGetBuilds(batchGetBuildsInputSchema.parse({
      region: "ap-northeast-1",
      buildIds: [buildId],
    }));

    expect(command.executable).toBe("aws");
    expect(command.args.slice(0, 2)).toEqual(["codebuild", "batch-get-builds"]);
    expect(command.args).toContain("--ids");
    expect(command.args).toContain(buildId);
    expect(command.args).toContain("--no-paginate");
  });

  it("projectとbuild IDを最大100件に制限する", () => {
    expect(() => batchGetProjectsInputSchema.parse({
      region: "ap-northeast-1",
      projects: Array.from({ length: 101 }, (_, index) => `project-${String(index)}`),
    })).toThrow();
    expect(() => batchGetBuildsInputSchema.parse({
      region: "ap-northeast-1",
      buildIds: Array.from({ length: 101 }, () => buildId),
    })).toThrow();
  });
});

describe("CodeBuildService", () => {
  it("project環境変数の値、registry credential、artifact情報を除外する", async () => {
    const service = new CodeBuildService(runnerFor({
      projects: [{
        name: "release-project",
        arn: "arn:aws:codebuild:ap-northeast-1:123456789012:project/release-project",
        source: { type: "CODEPIPELINE", location: "https://user:token@example.invalid/repo" },
        artifacts: { type: "S3", location: "private-bucket", encryptionDisabled: true },
        environment: {
          type: "LINUX_CONTAINER",
          image: "aws/codebuild/standard:7.0",
          computeType: "BUILD_GENERAL1_SMALL",
          environmentVariables: [{ name: "API_TOKEN", value: "secret", type: "PLAINTEXT" }],
          registryCredential: { credential: "arn:secret", credentialProvider: "SECRETS_MANAGER" },
        },
        logsConfig: {
          cloudWatchLogs: { status: "ENABLED", groupName: "/aws/codebuild/release-project", streamName: "project-stream" },
          s3Logs: { status: "DISABLED", location: "private-bucket/logs" },
        },
        badge: { badgeRequestUrl: "https://example.invalid?token=secret" },
      }],
      projectsNotFound: [],
    }), new CodeBuildCommandBuilder());

    await expect(service.batchGetProjects(batchGetProjectsInputSchema.parse({
      region: "ap-northeast-1",
      projects: ["release-project"],
    }))).resolves.toEqual({
      projects: [{
        name: "release-project",
        arn: "arn:aws:codebuild:ap-northeast-1:123456789012:project/release-project",
        source: { type: "CODEPIPELINE" },
        environment: {
          type: "LINUX_CONTAINER",
          image: "aws/codebuild/standard:7.0",
          computeType: "BUILD_GENERAL1_SMALL",
          environmentVariables: [{ name: "API_TOKEN", type: "PLAINTEXT" }],
        },
        logsConfig: {
          cloudWatchLogs: { status: "ENABLED", groupName: "/aws/codebuild/release-project", streamName: "project-stream" },
          s3Logs: { status: "DISABLED" },
        },
      }],
      projectsNotFound: [],
    });
  });

  it("phase診断とCloudWatch Logs識別子を保持しtoken相当fieldを除外する", async () => {
    const service = new CodeBuildService(runnerFor({
      builds: [{
        id: buildId,
        buildStatus: "FAILED",
        currentPhase: "BUILD",
        sourceVersion: "refs/heads/main",
        resolvedSourceVersion: "0123456789abcdef",
        phases: [{
          phaseType: "BUILD",
          phaseStatus: "FAILED",
          durationInSeconds: 12,
          contexts: [{ statusCode: "COMMAND_EXECUTION_ERROR", message: "command failed" }],
        }],
        environment: {
          image: "aws/codebuild/standard:7.0",
          environmentVariables: [{ name: "TOKEN", value: "secret", type: "PLAINTEXT" }],
          registryCredential: { credential: "secret" },
        },
        logs: {
          groupName: "/aws/codebuild/release-project",
          streamName: "123e4567-e89b-12d3-a456-426614174000",
          deepLink: "https://console.example.invalid/token",
        },
        exportedEnvironmentVariables: [{ name: "SESSION_TOKEN", value: "secret" }],
        debugSession: { sessionEnabled: true, sessionTarget: "token" },
        artifacts: { location: "arn:aws:s3:::private/output.zip" },
      }],
      buildsNotFound: [],
    }), new CodeBuildCommandBuilder());

    await expect(service.batchGetBuilds(batchGetBuildsInputSchema.parse({
      region: "ap-northeast-1",
      buildIds: [buildId],
    }))).resolves.toEqual({
      builds: [{
        id: buildId,
        currentPhase: "BUILD",
        buildStatus: "FAILED",
        sourceVersion: "refs/heads/main",
        resolvedSourceVersion: "0123456789abcdef",
        phases: [{
          phaseType: "BUILD",
          phaseStatus: "FAILED",
          durationInSeconds: 12,
          contexts: [{ statusCode: "COMMAND_EXECUTION_ERROR", message: "command failed" }],
        }],
        environment: {
          image: "aws/codebuild/standard:7.0",
          environmentVariables: [{ name: "TOKEN", type: "PLAINTEXT" }],
        },
        logs: {
          groupName: "/aws/codebuild/release-project",
          streamName: "123e4567-e89b-12d3-a456-426614174000",
        },
      }],
      buildsNotFound: [],
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