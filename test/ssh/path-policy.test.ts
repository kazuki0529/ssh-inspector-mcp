import { describe, expect, it } from "vitest";

import {
  PathAccessDeniedError,
  RemotePathPolicy,
  isWithinRoot,
} from "../../src/ssh/path-policy.js";

const identityRealpath = (path: string): Promise<string> => Promise.resolve(path);

describe("RemotePathPolicy", () => {
  it("用途別root内のcanonical pathを受理する", async () => {
    const policy = await RemotePathPolicy.create(identityRealpath, {
      allowedListRoots: ["/var/log"],
      allowedReadRoots: ["/var/log/application"],
      allowAllReadablePaths: false,
    });

    await expect(policy.resolveListPath("/var/log/application")).resolves.toBe(
      "/var/log/application",
    );
    await expect(policy.resolveReadPath("/var/log/application/app.log")).resolves.toBe(
      "/var/log/application/app.log",
    );
  });

  it("symlink解決後にroot外となるpathを拒否する", async () => {
    const realpath = (path: string): Promise<string> =>
      Promise.resolve(path === "/var/log/application/link" ? "/etc/shadow" : path);
    const policy = await RemotePathPolicy.create(realpath, {
      allowedListRoots: ["/var/log"],
      allowedReadRoots: ["/var/log/application"],
      allowAllReadablePaths: false,
    });

    await expect(policy.resolveReadPath("/var/log/application/link")).rejects.toBeInstanceOf(
      PathAccessDeniedError,
    );
  });

  it("broad readでもcredential pathを拒否する", async () => {
    const policy = await RemotePathPolicy.create(identityRealpath, {
      allowedListRoots: [],
      allowedReadRoots: [],
      allowAllReadablePaths: true,
    });

    await expect(policy.resolveReadPath("/home/inspector/.ssh/id_ed25519")).rejects.toThrow(
      /認証情報/,
    );
    await expect(policy.resolveReadPath("/proc/self/environ")).rejects.toThrow(/process環境/);
  });
});

describe("isWithinRoot", () => {
  it("path segment境界を越える隣接pathを許可しない", () => {
    expect(isWithinRoot("/var/log/app.log", "/var/log")).toBe(true);
    expect(isWithinRoot("/var/logger/app.log", "/var/log")).toBe(false);
  });
});