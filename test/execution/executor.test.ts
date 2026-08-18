import { PassThrough } from "node:stream";

import type { Client, ClientChannel } from "ssh2";
import { describe, expect, it } from "vitest";

import { executeRemoteCommand } from "../../src/execution/executor.js";

describe("executeRemoteCommand", () => {
  it("PTYなしで実行しstdout/stderr合計byte数を制限する", async () => {
    const channel = new PassThrough() as unknown as ClientChannel;
    const stderr = new PassThrough();
    Object.defineProperty(channel, "stderr", { value: stderr });
    channel.close = (): void => {
      channel.emit("close");
    };
    let rendered = "";
    let pty: boolean | undefined;
    const client = {
      exec(
        command: string,
        options: { pty?: boolean },
        callback: (error: Error | undefined, result: ClientChannel) => void,
      ) {
        rendered = command;
        pty = options.pty;
        callback(undefined, channel);
        return this;
      },
    } as unknown as Client;

    const resultPromise = executeRemoteCommand(
      client,
      { executable: "uname", args: ["-a"] },
      5,
      1_000,
    );
    channel.write("abcdef");
    const result = await resultPromise;

    expect(rendered).toBe("uname '-a'");
    expect(pty).toBe(false);
    expect(result.stdout).toBe("abcde");
    expect(result.truncated).toBe(true);
  });
});