import { describe, expect, it } from "vitest";

import { appConfigSchema } from "../../src/config/schema.js";

const baseConfig = {
  ssh: {
    host: "rhel.example.internal",
    username: "inspector",
    hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    authentication: {
      method: "privateKey" as const,
      privateKeyPath: "/home/user/.ssh/id_ed25519",
    },
  },
  access: {
    allowedListRoots: ["/var/log"],
    allowedReadRoots: ["/var/log/app"],
  },
};

describe("appConfigSchema", () => {
  it("秘密鍵認証と許可rootを持つ設定を受理する", () => {
    const result = appConfigSchema.parse(baseConfig);

    expect(result.ssh.port).toBe(22);
    expect(result.limits.maxOutputBytes).toBe(1_048_576);
  });

  it("SSHホスト鍵fingerprintがない設定を拒否する", () => {
    const ssh: Record<string, unknown> = { ...baseConfig.ssh };
    delete ssh.hostKeySha256;

    expect(() => appConfigSchema.parse({ ...baseConfig, ssh })).toThrow();
  });

  it("リスク承認なしの全可読範囲を拒否する", () => {
    const config = {
      ...baseConfig,
      access: {
        allowedListRoots: [],
        allowedReadRoots: [],
        allowAllReadablePaths: true,
      },
    };

    expect(() => appConfigSchema.parse(config)).toThrow(/リスク承認/);
  });

  it("許可rootも全可読範囲指定もない設定を拒否する", () => {
    const config = {
      ...baseConfig,
      access: {
        allowedListRoots: [],
        allowedReadRoots: [],
      },
    };

    expect(() => appConfigSchema.parse(config)).toThrow(/参照許可root/);
  });

  it("認証方式に未知のキーを含む設定を拒否する", () => {
    const config = {
      ...baseConfig,
      ssh: {
        ...baseConfig.ssh,
        authentication: {
          ...baseConfig.ssh.authentication,
          password: "埋め込み禁止",
        },
      },
    };

    expect(() => appConfigSchema.parse(config)).toThrow();
  });
});