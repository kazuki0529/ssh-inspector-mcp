import { describe, expect, it } from "vitest";

import {
  CommandPolicyError,
  renderCommand,
  type RemoteCommand,
} from "../../src/execution/render-command.js";

describe("renderCommand", () => {
  it("shell metacharacterとsingle quoteを一つのargv値としてquoteする", () => {
    const command: RemoteCommand = {
      executable: "grep",
      args: ["-F", "--", "a'; rm -rf /; echo '", "/var/log/app"],
    };

    expect(renderCommand(command)).toBe(
      "grep '-F' '--' 'a'\\''; rm -rf /; echo '\\''' '/var/log/app'",
    );
  });

  it("改行とNULを含むargvを拒否する", () => {
    expect(() =>
      renderCommand({ executable: "find", args: ["/var/log\n/etc"] }),
    ).toThrow(CommandPolicyError);
    expect(() =>
      renderCommand({ executable: "find", args: ["/var/log\0/etc"] }),
    ).toThrow(CommandPolicyError);
  });

  it("型検査を迂回した未知executableもruntimeで拒否する", () => {
    const command = {
      executable: "/bin/sh",
      args: ["-c", "id"],
    } as unknown as RemoteCommand;

    expect(() => renderCommand(command)).toThrow(/許可されていない/);
  });
});