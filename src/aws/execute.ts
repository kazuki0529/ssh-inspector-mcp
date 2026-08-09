import type {
  CommandExecutionResult,
  RemoteCommandRunner,
} from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";

/** AWS CLIが正常なJSON結果を返さなかったことを表します。 */
export class AwsExecutionError extends Error {
  /**
   * command本文を含めずに失敗理由と原因を保持します。
   *
   * @param message 利用者へ表示可能な理由
   * @param cause JSON parseなどの元例外
   */
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AwsExecutionError";
  }
}

/**
 * AWS CLI commandを実行し、成功した完全JSONだけを返します。
 *
 * @param runner bounded remote command runner
 * @param command AWS CLI builderが生成したcommand
 * @returns parse済みJSON
 */
export async function executeAwsJson(
  runner: RemoteCommandRunner,
  command: RemoteCommand,
): Promise<unknown> {
  const result = await runner.execute(command);
  assertSuccessfulResult(result);

  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new AwsExecutionError("AWS CLIが有効なJSONを返しませんでした", error);
  }
}

/**
 * truncated JSONや非zero終了をparse前に拒否します。
 *
 * @param result bounded command結果
 */
function assertSuccessfulResult(result: CommandExecutionResult): void {
  if (result.truncated) {
    throw new AwsExecutionError("AWS CLI出力がbyte上限を超えました");
  }
  if (result.exitCode !== 0) {
    throw new AwsExecutionError(
      `AWS CLIが終了code ${String(result.exitCode)} で失敗しました: ${result.stderr}`,
    );
  }
}