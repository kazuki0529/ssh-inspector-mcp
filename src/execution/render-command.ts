/** SSH先で実行を許可するexecutable一覧です。 */
export const ALLOWED_EXECUTABLES = [
  "aws",
  "/usr/bin/df",
  "/usr/bin/find",
  "/usr/bin/free",
  "/usr/bin/grep",
  "/usr/bin/ps",
  "/usr/bin/rpm",
  "/usr/bin/systemctl",
  "/usr/bin/uname",
  "/usr/bin/uptime",
] as const;

/** 許可されたabsolute executable型です。 */
export type AllowedExecutable = (typeof ALLOWED_EXECUTABLES)[number];

/** rendererへ渡せる構造化commandです。 */
export interface RemoteCommand {
  executable: AllowedExecutable;
  args: readonly string[];
}

/** command policy違反を表します。 */
export class CommandPolicyError extends Error {
  /**
   * 利用者入力を含まないpolicy違反理由を保持します。
   *
   * @param message 拒否理由
   */
  public constructor(message: string) {
    super(message);
    this.name = "CommandPolicyError";
  }
}

const allowedExecutableSet = new Set<string>(ALLOWED_EXECUTABLES);

/**
 * 固定executableと個別quoteしたargvから、ssh2 execへ渡すcommand文字列を生成します。
 *
 * shell operatorやoptionを利用者入力から生成せず、control文字をfail closedで拒否します。
 *
 * @param command 構造化command
 * @returns POSIX shellで単一commandとして解釈される文字列
 */
export function renderCommand(command: RemoteCommand): string {
  if (!allowedExecutableSet.has(command.executable)) {
    throw new CommandPolicyError("許可されていない実行fileです");
  }
  if (command.args.length > 256) {
    throw new CommandPolicyError("引数件数が上限を超えています");
  }

  const renderedArgs = command.args.map((argument) => quoteArgument(argument));
  const rendered = [command.executable, ...renderedArgs].join(" ");

  if (Buffer.byteLength(rendered, "utf8") > 32_768) {
    throw new CommandPolicyError("command長が上限を超えています");
  }

  return rendered;
}

/**
 * argv要素をPOSIX shellのsingle-quoted wordへ変換します。
 *
 * @param argument 一つのargv値
 * @returns operator解釈されないquoted word
 */
function quoteArgument(argument: string): string {
  if (Buffer.byteLength(argument, "utf8") > 8_192) {
    throw new CommandPolicyError("引数長が上限を超えています");
  }
  if ([...argument].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  })) {
    throw new CommandPolicyError("引数にcontrol文字は使用できません");
  }

  return `'${argument.replaceAll("'", `'\\''`)}'`;
}