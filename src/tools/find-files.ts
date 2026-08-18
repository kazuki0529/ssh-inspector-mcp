import type { AppConfig } from "../config/schema.js";
import type { RemoteCommandRunner } from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";
import type { SftpSessionProvider } from "../ssh/client.js";
import { RemotePathPolicy } from "../ssh/path-policy.js";

/** findで公開するfile type条件です。 */
export type FindFileType = "any" | "directory" | "file";

/** find operationの構造化入力です。 */
export interface FindFilesInput {
  root: string;
  nameGlob?: string | undefined;
  caseInsensitiveName?: boolean | undefined;
  type: FindFileType;
  modifiedAfter?: string | undefined;
  modifiedBefore?: string | undefined;
  minSizeBytes?: number | undefined;
  maxSizeBytes?: number | undefined;
  excludePathGlobs?: readonly string[] | undefined;
  maxDepth: number;
  limit: number;
}

/** bounded find結果です。 */
export interface FindFilesResult {
  root: string;
  paths: readonly string[];
  exitCode: number | null;
  truncated: boolean;
}

/**
 * `find` の安全な部分集合だけを構造化入力から生成します。
 *
 * @param input canonical rootを含む検証済み入力
 * @returns 固定executableとargv
 */
export function buildFindCommand(input: FindFilesInput): RemoteCommand {
  const args = [input.root, "-maxdepth", String(input.maxDepth)];

  if (input.type === "file") {
    args.push("-type", "f");
  } else if (input.type === "directory") {
    args.push("-type", "d");
  }
  if (input.nameGlob !== undefined) {
    args.push(input.caseInsensitiveName === true ? "-iname" : "-name", input.nameGlob);
  }
  if (input.modifiedAfter !== undefined) {
    args.push("-newermt", input.modifiedAfter);
  }
  if (input.modifiedBefore !== undefined) {
    args.push("-not", "-newermt", input.modifiedBefore);
  }
  if (input.minSizeBytes !== undefined && input.minSizeBytes > 0) {
    args.push("-size", `+${String(input.minSizeBytes - 1)}c`);
  }
  if (input.maxSizeBytes !== undefined) {
    args.push("-size", `-${String(input.maxSizeBytes + 1)}c`);
  }
  for (const excludedPath of input.excludePathGlobs ?? []) {
    args.push("-not", "-path", excludedPath);
  }
  args.push("-print0");

  return { executable: "find", args };
}

/**
 * SFTP path policyと固定find builderを結合します。
 */
export class FindFilesService {
  readonly #runner: RemoteCommandRunner;
  readonly #sessions: SftpSessionProvider;
  readonly #config: AppConfig;

  /**
   * command runnerとpath policy依存を固定します。
   *
   * @param runner bounded command runner
   * @param sessions canonical path解決用SFTP provider
   * @param config 検証済み起動設定
   */
  public constructor(
    runner: RemoteCommandRunner,
    sessions: SftpSessionProvider,
    config: AppConfig,
  ) {
    this.#runner = runner;
    this.#sessions = sessions;
    this.#config = config;
  }

  /**
   * 許可root内だけを検索し、NUL区切り出力を上限件数まで返します。
   *
   * @param input 検証済みtool入力
   * @returns bounded path一覧
   */
  public async find(input: FindFilesInput): Promise<FindFilesResult> {
    const canonicalRoot = await this.#resolveRoot(input.root);
    const maximum = Math.min(input.limit, this.#config.limits.maxResults);
    const result = await this.#runner.execute(buildFindCommand({ ...input, root: canonicalRoot }));

    if (result.exitCode !== 0 && result.exitCode !== null) {
      throw new Error(`findが終了code ${result.exitCode} で失敗しました: ${result.stderr}`);
    }

    const paths = result.stdout.split("\0").filter((path) => path.length > 0);

    return {
      root: canonicalRoot,
      paths: paths.slice(0, maximum),
      exitCode: result.exitCode,
      truncated: result.truncated || paths.length > maximum,
    };
  }

  /**
   * list用途のallowlistでrootをcanonicalizeします。
   *
   * @param root 利用者指定root
   * @returns 許可されたcanonical root
   */
  async #resolveRoot(root: string): Promise<string> {
    return this.#sessions.withSftp(async (fileSystem) => {
      const policy = await RemotePathPolicy.create(fileSystem.realpath.bind(fileSystem), {
        allowedListRoots: this.#config.access.allowedListRoots,
        allowedReadRoots: this.#config.access.allowedReadRoots,
        allowAllReadablePaths: this.#config.access.allowAllReadablePaths,
      });

      return policy.resolveListPath(root);
    });
  }
}