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
  createFindFilesInputSchema,
  createSearchTextInputSchema,
} from "../../src/tools/register-rhel-tools.js";
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
        modifiedAfter: "2026-08-09T00:00:00+09:00",
        maxDepth: 4,
        limit: 10,
      }),
    ).toEqual({
      executable: "/usr/bin/find",
      args: [
        "/var/log",
        "-maxdepth",
        "4",
        "-type",
        "f",
        "-name",
        "*.log",
        "-newermt",
        "2026-08-09T00:00:00+09:00",
        "-print0",
      ],
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

    expect(command.args.slice(-4)).toEqual(["--", "'; uname -a; '", "{}", "+"]);
    expect(rendered).toContain("''\\''; uname -a; '\\''' ");
  });

  it("圧縮logを固定find -execとzgrepで再帰検索する", () => {
    const command = buildGrepCommand({
      root: "/var/log/app",
      query: "ERROR",
      mode: "literal",
      caseSensitive: false,
      compression: "gzip",
      includeGlob: "*.log.gz",
      limit: 10,
    });

    expect(command).toEqual({
      executable: "/usr/bin/find",
      args: [
        "/var/log/app",
        "-maxdepth",
        "8",
        "-type",
        "f",
        "-name",
        "*.log.gz",
        "-exec",
        "/usr/bin/zgrep",
        "--binary-files=without-match",
        "--line-number",
        "--with-filename",
        "--no-messages",
        "--fixed-strings",
        "--ignore-case",
        "--",
        "ERROR",
        "{}",
        "+",
      ],
    });
  });

  it.each([
    ["none", "/usr/bin/grep"],
    ["gzip", "/usr/bin/zgrep"],
    ["bzip2", "/usr/bin/bzgrep"],
    ["xz", "/usr/bin/xzgrep"],
  ] as const)("%s検索で固定executableだけを使う", (compression, executable) => {
    const command = buildGrepCommand({
      root: "/var/log/app",
      query: "--include=*",
      mode: "literal",
      caseSensitive: true,
      compression,
      limit: 10,
    });

    expect(command.executable).toBe("/usr/bin/find");
    expect(command.args).toContain(executable);
    expect(command.args.slice(-4)).toEqual(["--", "--include=*", "{}", "+"]);
  });

  it("findの日時・size・除外条件を固定argvへ配置する", () => {
    const command = buildFindCommand({
      root: "/var/log",
      nameGlob: "*.LOG",
      caseInsensitiveName: true,
      type: "file",
      modifiedAfter: "2026-08-10T00:00:00Z",
      modifiedBefore: "2026-08-11T00:00:00Z",
      minSizeBytes: 1_024,
      maxSizeBytes: 2_048,
      excludePathGlobs: ["*/archive/*"],
      maxDepth: 4,
      limit: 10,
    });

    expect(command.args).toEqual([
      "/var/log", "-maxdepth", "4", "-type", "f", "-iname", "*.LOG",
      "-newermt", "2026-08-10T00:00:00Z", "-not", "-newermt", "2026-08-11T00:00:00Z",
      "-size", "+1023c", "-size", "-2049c", "-not", "-path", "*/archive/*", "-print0",
    ]);
  });
});

describe("RHEL tool input schemas", () => {
  it("逆転した日時・size範囲を拒否する", () => {
    const schema = createFindFilesInputSchema(100);

    expect(() => schema.parse({
      root: "/var/log",
      modifiedAfter: "2026-08-11T00:00:00Z",
      modifiedBefore: "2026-08-10T00:00:00Z",
    })).toThrow(/modifiedBefore/);
    expect(() => schema.parse({ root: "/var/log", minSizeBytes: 2, maxSizeBytes: 1 })).toThrow(/maxSizeBytes/);
  });

  it("file名だけの検索とcontext指定を同時に許可しない", () => {
    const schema = createSearchTextInputSchema(100);

    expect(() => schema.parse({
      root: "/var/log",
      query: "ERROR",
      filesWithMatchesOnly: true,
      contextBefore: 1,
    })).toThrow(/context/);
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