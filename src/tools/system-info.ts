import type { AppConfig } from "../config/schema.js";
import type {
  CommandExecutionResult,
  RemoteCommandRunner,
} from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";

/** 引数なしで参照できるsystem情報種別です。 */
export type BasicSystemInfoKind =
  | "filesystem"
  | "kernel"
  | "memory"
  | "processes"
  | "release"
  | "uptime";

/** system情報toolの構造化入力です。 */
export type SystemInfoInput =
  | { kind: BasicSystemInfoKind }
  | { kind: "package"; packageName: string }
  | { kind: "service"; unit: string };

/** system情報のbounded実行結果です。 */
export interface SystemInfoResult extends CommandExecutionResult {
  kind: SystemInfoInput["kind"];
}

/**
 * system情報種別を固定command templateへ変換します。
 *
 * @param input 検証済みtool入力
 * @returns 固定executableとargv
 */
export function buildSystemInfoCommand(input: SystemInfoInput): RemoteCommand {
  switch (input.kind) {
    case "release":
      return { executable: "rpm", args: ["--eval", "%{rhel}"] };
    case "kernel":
      return { executable: "uname", args: ["-a"] };
    case "uptime":
      return { executable: "uptime", args: [] };
    case "filesystem":
      return { executable: "df", args: ["-hPT"] };
    case "memory":
      return { executable: "free", args: ["-b"] };
    case "processes":
      return {
        executable: "ps",
        args: ["-eo", "pid,ppid,user,stat,etimes,comm", "--sort=-etimes"],
      };
    case "package":
      return { executable: "rpm", args: ["-q", "--", input.packageName] };
    case "service":
      return {
        executable: "systemctl",
        args: ["status", "--no-pager", "--full", "--", input.unit],
      };
  }
}

/**
 * 固定templateとservice allowlistを適用してRHEL system情報を参照します。
 */
export class SystemInfoService {
  readonly #runner: RemoteCommandRunner;
  readonly #allowedUnits: ReadonlySet<string>;

  /**
   * command runnerと起動時allowlistを固定します。
   *
   * @param runner bounded command runner
   * @param config 検証済み起動設定
   */
  public constructor(runner: RemoteCommandRunner, config: AppConfig) {
    this.#runner = runner;
    this.#allowedUnits = new Set(config.access.allowedSystemdUnits);
  }

  /**
   * 許可された固定templateを実行します。
   *
   * @param input 検証済みtool入力
   * @returns bounded stdout/stderrと終了状態
   */
  public async inspect(input: SystemInfoInput): Promise<SystemInfoResult> {
    if (input.kind === "service" && !this.#allowedUnits.has(input.unit)) {
      throw new Error("systemd unitがallowlistにありません");
    }

    const result = await this.#runner.execute(buildSystemInfoCommand(input));

    return { kind: input.kind, ...result };
  }
}