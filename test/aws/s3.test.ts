import { describe, expect, it, vi } from "vitest";

import { appConfigSchema } from "../../src/config/schema.js";
import type { CommandExecutionResult, RemoteCommandRunner } from "../../src/execution/executor.js";
import {
  S3CommandBuilder,
  S3Service,
  getObjectTextInputSchema,
} from "../../src/aws/s3.js";

const config = appConfigSchema.parse({
  ssh: {
    host: "rhel.example.internal",
    username: "inspector",
    hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    authentication: { method: "privateKey", privateKeyPath: "/tmp/key" },
  },
  access: { allowedListRoots: ["/var/log"] },
  limits: { maxOutputBytes: 16_384 },
});

const result = (stdout: string): CommandExecutionResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  signal: null,
  truncated: false,
});

describe("S3Service", () => {
  it("list-buckets結果をIAMの応答どおり返す", async () => {
    const runner: RemoteCommandRunner = {
      execute: vi.fn(() => Promise.resolve(result(JSON.stringify({
        Buckets: [
          { Name: "allowed-bucket", CreationDate: "2026-01-01" },
          { Name: "secret-bucket", CreationDate: "2026-01-01" },
        ]
      })))),
    };
    const service = new S3Service(runner, new S3CommandBuilder(), config);

    const response = await service.listBuckets({ region: "ap-northeast-1" });

    expect(response.result).toEqual({
      Buckets: [
        { Name: "allowed-bucket", CreationDate: "2026-01-01" },
        { Name: "secret-bucket", CreationDate: "2026-01-01" },
      ]
    });
  });

  it("head metadata確認後に指定rangeのtextだけを返す", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce(result(JSON.stringify({ ContentLength: 11, ContentType: "text/plain; charset=utf-8" })))
      .mockResolvedValueOnce(result("worldAWS_METADATA"));
    const runner: RemoteCommandRunner = { execute };
    const builder = new S3CommandBuilder();
    const service = new S3Service(runner, builder, config);
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
    const execute = vi.fn(() => Promise.resolve(result(JSON.stringify({ ContentLength: 5, ContentType: "application/octet-stream" }))));
    const service = new S3Service({ execute }, new S3CommandBuilder(), config);

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