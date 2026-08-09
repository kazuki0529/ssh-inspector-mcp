import type { Client, ClientChannel } from "ssh2";

import { renderCommand, type RemoteCommand } from "./render-command.js";

/** remote commandのbounded実行結果です。 */
export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
}

/** operation単位でglobal上限を狭める実行optionです。 */
export interface CommandExecutionOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** 固定builderが生成したcommandだけを実行する境界です。 */
export interface RemoteCommandRunner {
  execute(command: RemoteCommand, options?: CommandExecutionOptions): Promise<CommandExecutionResult>;
}

/** remote command実行失敗を表します。 */
export class CommandExecutionError extends Error {
  /**
   * command本文を含めずに失敗理由と原因を保持します。
   *
   * @param message 利用者へ表示可能な理由
   * @param cause ssh2の元例外
   */
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CommandExecutionError";
  }
}

/**
 * PTY・envなしで固定commandを実行し、stdout/stderr合計byte数と時間を制限します。
 *
 * @param client ready状態のssh2 client
 * @param command policy検証対象の構造化command
 * @param maxOutputBytes stdout/stderr合計上限
 * @param timeoutMs 実行時間上限
 * @returns bounded実行結果
 */
export async function executeRemoteCommand(
  client: Client,
  command: RemoteCommand,
  maxOutputBytes: number,
  timeoutMs: number,
): Promise<CommandExecutionResult> {
  const renderedCommand = renderCommand(command);

  return new Promise((resolve, reject) => {
    client.exec(renderedCommand, { pty: false }, (openError, channel) => {
      if (openError) {
        reject(new CommandExecutionError("SSH exec channelを開始できません", openError));
        return;
      }

      collectCommandOutput(channel, maxOutputBytes, timeoutMs).then(resolve, reject);
    });
  });
}

/**
 * channel出力を合計上限まで保持し、上限到達時はremote processを停止します。
 *
 * @param channel ssh2 exec channel
 * @param maxOutputBytes stdout/stderr合計上限
 * @param timeoutMs 実行時間上限
 * @returns bounded実行結果
 */
async function collectCommandOutput(
  channel: ClientChannel,
  maxOutputBytes: number,
  timeoutMs: number,
): Promise<CommandExecutionResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (target: Buffer[], chunk: Buffer | string): void => {
      const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxOutputBytes - capturedBytes;

      if (remaining <= 0) {
        truncated = true;
        channel.close();
        return;
      }

      const accepted = source.subarray(0, remaining);
      target.push(accepted);
      capturedBytes += accepted.length;

      if (accepted.length < source.length) {
        truncated = true;
        channel.close();
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      channel.close();
    }, timeoutMs);

    channel.on("data", (chunk: Buffer | string) => {
      append(stdout, chunk);
    });
    channel.stderr.on("data", (chunk: Buffer | string) => {
      append(stderr, chunk);
    });
    channel.on("exit", (code: number | null, signal?: string) => {
      exitCode = code;
      exitSignal = signal ?? null;
    });
    channel.once("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(new CommandExecutionError("remote command実行中にSSHエラーが発生しました", error));
    });
    channel.once("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      if (timedOut) {
        reject(new CommandExecutionError("remote commandがtimeoutしました"));
        return;
      }

      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal: exitSignal,
        truncated,
      });
    });
  });
}