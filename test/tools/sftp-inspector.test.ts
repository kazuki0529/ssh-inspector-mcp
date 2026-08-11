import { describe, expect, it, vi } from "vitest";

import { appConfigSchema } from "../../src/config/schema.js";
import type { SftpSessionProvider } from "../../src/ssh/client.js";
import type { RemoteFileStat, RemoteFileSystem } from "../../src/ssh/sftp.js";
import {
  SftpInspector,
  decodeUtf8Boundary,
} from "../../src/tools/sftp-inspector.js";

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
  },
  limits: {
    maxOutputBytes: 1_024,
    maxReadLines: 10,
    maxReadScanBytes: 1_024,
  },
});

const createInspector = (
  content: Buffer,
  options: {
    realpath?: (path: string) => string;
    stat?: RemoteFileStat;
  } = {},
): { inspector: SftpInspector; readRange: ReturnType<typeof vi.fn> } => {
  const readRange = vi.fn(
    (_path: string, start: number, maxBytes: number): Promise<Buffer> =>
      Promise.resolve(content.subarray(start, start + maxBytes)),
  );
  const fileSystem: RemoteFileSystem = {
    realpath: (path) => Promise.resolve(options.realpath?.(path) ?? path),
    readdir: () =>
      Promise.resolve([
        {
          name: ".hidden",
          type: "file",
          size: 1,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          mode: "0640",
        },
        {
          name: "app.log",
          type: "file",
          size: content.length,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          mode: "0640",
        },
      ]),
    stat: () => Promise.resolve(options.stat ?? {
      size: content.length,
      isFile: true,
      type: "file",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      mode: "0640",
    }),
    readRange,
    close: vi.fn(),
  };
  const sessions: SftpSessionProvider = {
    withSftp: async (operation) => operation(fileSystem, new AbortController().signal),
  };

  return { inspector: new SftpInspector(sessions, config), readRange };
};

describe("SftpInspector", () => {
  it("hidden entryを除いたdirectory metadataを返す", async () => {
    const { inspector } = createInspector(Buffer.from("content"));

    const result = await inspector.listDirectory("/var/log/app", false, 10);

    expect(result.entries.map((entry) => entry.name)).toEqual(["app.log"]);
    expect(result.truncated).toBe(false);
  });

  it("symlink解決後のcanonical file metadataを返す", async () => {
    const { inspector } = createInspector(Buffer.from("content"), {
      realpath: (path) => path === "/var/log/link" ? "/var/log/app/app.log" : path,
    });

    const result = await inspector.getFileMetadata("/var/log/link");

    expect(result).toEqual({
      requestedPath: "/var/log/link",
      path: "/var/log/app/app.log",
      symlinkResolved: true,
      type: "file",
      size: 7,
      modifiedAt: "2026-01-01T00:00:00.000Z",
      mode: "0640",
    });
  });

  it("directory metadataを本文なしで返す", async () => {
    const { inspector, readRange } = createInspector(Buffer.alloc(0), {
      stat: {
        size: 4_096,
        isFile: false,
        type: "directory",
        modifiedAt: "2026-01-02T00:00:00.000Z",
        mode: "0750",
      },
    });

    const result = await inspector.getFileMetadata("/var/log/app");

    expect(result.type).toBe("directory");
    expect(result.mode).toBe("0750");
    expect(readRange).not.toHaveBeenCalled();
  });

  it("file先頭を指定line数に制限する", async () => {
    const { inspector, readRange } = createInspector(Buffer.from("first\nsecond\nthird\n"));

    const result = await inspector.readHead("/var/log/app/app.log", 2);

    expect(result.text).toBe("first\nsecond\n");
    expect(result.truncated).toBe(true);
    expect(readRange).toHaveBeenCalledWith(
      "/var/log/app/app.log",
      0,
      19,
      expect.any(AbortSignal),
    );
  });

  it("file末尾をbyte上限と指定line数に制限する", async () => {
    const content = Buffer.from(`${"x".repeat(1_100)}\nlast\n`);
    const { inspector, readRange } = createInspector(content);

    const result = await inspector.readTail("/var/log/app/app.log", 1);

    expect(result.text).toBe("last\n");
    expect(result.bytesRead).toBe(1_024);
    expect(result.truncated).toBe(true);
    expect(readRange).toHaveBeenCalledWith(
      "/var/log/app/app.log",
      content.length - 1_024,
      1_024,
      expect.any(AbortSignal),
    );
  });

  it("NULを含むbinary fileを拒否する", async () => {
    const { inspector } = createInspector(Buffer.from([0x61, 0x00, 0x62]));

    await expect(inspector.readHead("/var/log/app/binary", 1)).rejects.toThrow(/binary/);
  });

  it("1始まりの指定line範囲だけを返す", async () => {
    const { inspector } = createInspector(Buffer.from("first\nsecond\nthird\nfourth\n"));

    const result = await inspector.readRange("/var/log/app/app.log", 2, 2);

    expect(result).toMatchObject({ text: "second\nthird\n", startLine: 2, linesRead: 2, truncated: true });
  });

  it("最大scan bytesより後のstartLineを拒否する", async () => {
    const { inspector } = createInspector(Buffer.from("a\n".repeat(600)));

    await expect(inspector.readRange("/var/log/app/app.log", 600, 1)).rejects.toThrow(/最大走査byte/);
  });

  it("read allowlist外のrange取得を拒否する", async () => {
    const { inspector } = createInspector(Buffer.from("content"));

    await expect(inspector.readRange("/var/log/other.log", 1, 1)).rejects.toThrow(/rootの外/);
  });

  it("range取得でも不正UTF-8を拒否する", async () => {
    const { inspector } = createInspector(Buffer.from([0xff, 0xff, 0xff, 0xff]));

    await expect(inspector.readRange("/var/log/app/binary", 1, 1)).rejects.toThrow(/UTF-8/);
  });
});

describe("decodeUtf8Boundary", () => {
  it("byte上限で分断された末尾UTF-8文字だけを除く", () => {
    const splitCharacter = Buffer.from("abcあ").subarray(0, 5);

    expect(decodeUtf8Boundary(splitCharacter, "head")).toBe("abc");
  });

  it("境界補正で救済できない不正UTF-8を拒否する", () => {
    expect(() => decodeUtf8Boundary(Buffer.from([0xff, 0xff, 0xff, 0xff]), "head")).toThrow(
      /UTF-8/,
    );
  });
});