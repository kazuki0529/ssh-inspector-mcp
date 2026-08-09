import { describe, expect, it, vi } from "vitest";

import { appConfigSchema } from "../../src/config/schema.js";
import type {
  CommandExecutionResult,
  RemoteCommandRunner,
} from "../../src/execution/executor.js";
import { renderCommand, type RemoteCommand } from "../../src/execution/render-command.js";
import type { SftpSessionProvider } from "../../src/ssh/client.js";
import type { RemoteFileSystem } from "../../src/ssh/sftp.js";
import {
  buildFindCommand,
  FindFilesService,
} from "../../src/tools/find-files.js";
import {
  buildGrepCommand,
  SearchTextService,
} from "../../src/tools/search-text.js";
import {
  buildSystemInfoCommand,
  SystemInfoService,
} from "../../src/tools/system-info.js";

const config = appConfigSchema.parse({
  ssh: {
    host: "rhel.example.internal",
    username: "inspector",
    hostKeySha256: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    authentication: {
      method: "privateKey",
      privateKeyPath: "/tmp/id_ed25519",
    },
  },
  access: {
    allowedListRoots: ["/var/log"],
    allowedReadRoots: ["/var/log/app"],
    allowedSystemdUnits: ["application.service"],
  },
  limits: {
    maxResults: 2,
  },
});

const fileSystem: RemoteFileSystem = {
  realpath: (path) => Promise.resolve(path.replace("/alias", "/var/log/app")),
  readdir: () => Promise.resolve([]),
  stat: () => Promise.resolve({ size: 0, isFile: true }),
  readRange: () => Promise.resolve(Buffer.alloc(0)),
  close: vi.fn(),
};

const sessions: SftpSessionProvider = {
  withSftp: async (operation) => operation(fileSystem, new AbortController().signal),
};

const successfulResult = (stdout: string): CommandExecutionResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  signal: null,
  truncated: false,
});

describe("RHEL command builders", () => {
  it("findの表現可能な条件だけをargvへ配置する", () => {
    expect(
      buildFindCommand({
        root: "/var/log",
        nameGlob: "*.log",
        type: "file",
        maxDepth: 4,
        limit: 10,
      }),
    ).toEqual({
      executable: "/usr/bin/find",
      args: ["/var/log", "-maxdepth", "4", "-type", "f", "-name", "*.log", "-print0"],
    });
  });

  it("grep queryをoption終端後の独立argvとして配置する", () => {
    const command = buildGrepCommand({
      root: "/var/log/app",
      query: "'; uname -a; '",
      mode: "literal",
      caseSensitive: false,
      limit: 10,
    });
    const rendered = renderCommand(command);

    expect(command.args.slice(-3)).toEqual(["--", "'; uname -a; '", "/var/log/app"]);
    expect(rendered).toContain("''\\''; uname -a; '\\''' ");
  });

  it("system情報種別を固定templateへ変換する", () => {
    expect(buildSystemInfoCommand({ kind: "memory" })).toEqual({
      executable: "/usr/bin/free",
      args: ["-b"],
    });
  });
});

describe("RHEL services", () => {
  it("findにcanonical rootを使いresult件数を制限する", async () => {
    const commands: RemoteCommand[] = [];
    const runner: RemoteCommandRunner = {
      execute: vi.fn((command: RemoteCommand) => {
        commands.push(command);
        return Promise.resolve(successfulResult("/var/log/app/a\0/var/log/app/b\0/var/log/app/c\0"));
      }),
    };
    const service = new FindFilesService(runner, sessions, config);

    const result = await service.find({
      root: "/alias",
      type: "any",
      maxDepth: 2,
      limit: 2,
    });

    expect(commands[0]?.args[0]).toBe("/var/log/app");
    expect(result.paths).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("grepのmatchなし終了code 1を正常結果として扱う", async () => {
    const runner: RemoteCommandRunner = {
      execute: vi.fn(() => Promise.resolve({ ...successfulResult(""), exitCode: 1 })),
    };
    const service = new SearchTextService(runner, sessions, config);

    const result = await service.search({
      root: "/var/log/app",
      query: "missing",
      mode: "literal",
      caseSensitive: true,
      limit: 2,
    });

    expect(result.matches).toEqual([]);
  });

  it("allowlist外のsystemd unitをcommand実行前に拒否する", async () => {
    const execute = vi.fn(() => Promise.resolve(successfulResult("")));
    const runner: RemoteCommandRunner = {
      execute,
    };
    const service = new SystemInfoService(runner, config);

    await expect(service.inspect({ kind: "service", unit: "sshd.service" })).rejects.toThrow(
      /allowlist/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});