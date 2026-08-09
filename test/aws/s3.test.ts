import { describe, expect, it, vi } from "vitest";

import { appConfigSchema } from "../../src/config/schema.js";
import type { CommandExecutionResult, RemoteCommandRunner } from "../../src/execution/executor.js";
import {
  S3AccessPolicy,
  S3CommandBuilder,
  S3Service,
  getObjectTextInputSchema,
  isWithinS3Prefix,
} from "../../src/aws/s3.js";

const createConfig = (allowObjectContent: boolean) => appConfigSchema.parse({
  ssh: {
    host: "rhel.example.internal",
    username: "inspector",
    hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    authentication: { method: "privateKey", privateKeyPath: "/tmp/key" },
  },
  access: { allowedListRoots: ["/var/log"] },
  limits: { maxOutputBytes: 16_384 },
  aws: {
    allowedRegions: ["ap-northeast-1"],
    s3: [{ bucket: "allowed-bucket", prefixes: ["logs/"], allowObjectContent }],
  },
});

const result = (stdout: string): CommandExecutionResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  signal: null,
  truncated: false,
});

describe("S3AccessPolicy", () => {
  it("prefix segment境界を越える隣接keyを許可しない", () => {
    expect(isWithinS3Prefix("logs/app/a.log", "logs/")).toBe(true);
    expect(isWithinS3Prefix("logs-private/a.log", "logs/")).toBe(false);
  });

  it("metadata許可と本文許可を分離する", () => {
    const policy = new S3AccessPolicy(createConfig(false));

    expect(() => policy.assertMetadataAllowed("allowed-bucket", "logs/app.log")).not.toThrow();
    expect(() => policy.assertContentAllowed("allowed-bucket", "logs/app.log")).toThrow(/本文/);
  });
});

describe("S3Service", () => {
  it("list-buckets結果を設定bucketだけへfilterする", async () => {
    const config = createConfig(false);
    const policy = new S3AccessPolicy(config);
    const runner: RemoteCommandRunner = {
      execute: vi.fn(() => Promise.resolve(result(JSON.stringify({ Buckets: [
        { Name: "allowed-bucket", CreationDate: "2026-01-01" },
        { Name: "secret-bucket", CreationDate: "2026-01-01" },
      ] })))),
    };
    const service = new S3Service(runner, new S3CommandBuilder(config, policy), policy, config);

    const response = await service.listBuckets({ region: "ap-northeast-1" });

    expect(response.result).toEqual({ Buckets: [{ Name: "allowed-bucket", CreationDate: "2026-01-01" }] });
  });

  it("head metadata確認後に指定rangeのtextだけを返す", async () => {
    const config = createConfig(true);
    const policy = new S3AccessPolicy(config);
    const execute = vi.fn()
      .mockResolvedValueOnce(result(JSON.stringify({ ContentLength: 11, ContentType: "text/plain; charset=utf-8" })))
      .mockResolvedValueOnce(result("worldAWS_METADATA"));
    const runner: RemoteCommandRunner = { execute };
    const builder = new S3CommandBuilder(config, policy);
    const service = new S3Service(runner, builder, policy, config);
    const input = getObjectTextInputSchema.parse({
      region: "ap-northeast-1",
      bucket: "allowed-bucket",
      key: "logs/app.log",
      startByte: 6,
      maxBytes: 5,
    });

    const response = await service.getObjectText(input);
    const getCommand = execute.mock.calls[1]?.[0] as { args: string[] };

    expect(response).toEqual({ text: "world", bytesRead: 5, truncated: false });
    expect(getCommand.args).toContain("bytes=6-10");
    expect(getCommand.args.at(-1)).toBe("/dev/stdout");
  });

  it("binary content-typeをget-object前に拒否する", async () => {
    const config = createConfig(true);
    const policy = new S3AccessPolicy(config);
    const execute = vi.fn(() => Promise.resolve(result(JSON.stringify({ ContentLength: 5, ContentType: "application/octet-stream" }))));
    const service = new S3Service({ execute }, new S3CommandBuilder(config, policy), policy, config);

    await expect(service.getObjectText({
      region: "ap-northeast-1",
      bucket: "allowed-bucket",
      key: "logs/file.bin",
      startByte: 0,
      maxBytes: 5,
    })).rejects.toThrow(/text content-type/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});