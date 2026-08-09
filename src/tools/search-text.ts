import type { AppConfig } from "../config/schema.js";
import type { RemoteCommandRunner } from "../execution/executor.js";
import type { RemoteCommand } from "../execution/render-command.js";
import type { SftpSessionProvider } from "../ssh/client.js";
import { RemotePathPolicy } from "../ssh/path-policy.js";

/** grep patternの解釈方式です。 */
export type SearchPatternMode = "literal" | "extendedRegex";

/** grep operationの構造化入力です。 */
export interface SearchTextInput {
  root: string;
  query: string;
  mode: SearchPatternMode;
  caseSensitive: boolean;
  includeGlob?: string | undefined;
  limit: number;
}

/** bounded grep結果です。 */
export interface SearchTextResult {
  root: string;
  matches: readonly string[];
  exitCode: number | null;
  truncated: boolean;
}

/**
 * `/usr/bin/grep` のrecursive read-only subsetを構造化入力から生成します。
 *
 * @param input canonical rootを含む検証済み入力
 * @returns 固定executableとargv
 */
export function buildGrepCommand(input: SearchTextInput): RemoteCommand {
  const args = [
    "--recursive",
    "--directories=recurse",
    "--devices=skip",
    "--binary-files=without-match",
    "--line-number",
    "--with-filename",
    "--no-messages",
    input.mode === "literal" ? "--fixed-strings" : "--extended-regexp",
  ];

  if (!input.caseSensitive) {
    args.push("--ignore-case");
  }
  if (input.includeGlob !== undefined) {
    args.push(`--include=${input.includeGlob}`);
  }
  args.push("--", input.query, input.root);

  return { executable: "/usr/bin/grep", args };
}

/**
 * read path policyと固定grep builderを結合します。
 */
export class SearchTextService {
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
   * 許可read root内だけを検索し、match行を上限件数まで返します。
   *
   * @param input 検証済みtool入力
   * @returns bounded match一覧
   */
  public async search(input: SearchTextInput): Promise<SearchTextResult> {
    const canonicalRoot = await this.#resolveRoot(input.root);
    const maximum = Math.min(input.limit, this.#config.limits.maxResults);
    const result = await this.#runner.execute(buildGrepCommand({ ...input, root: canonicalRoot }));

    // grepの1はmatchなしであり、operation失敗として扱いません。
    if (result.exitCode !== 0 && result.exitCode !== 1 && result.exitCode !== null) {
      throw new Error(`grepが終了code ${result.exitCode} で失敗しました: ${result.stderr}`);
    }

    const matches = result.stdout.split("\n").filter((line) => line.length > 0);

    return {
      root: canonicalRoot,
      matches: matches.slice(0, maximum),
      exitCode: result.exitCode,
      truncated: result.truncated || matches.length > maximum,
    };
  }

  /**
   * 本文検索なのでread用途のallowlistでrootをcanonicalizeします。
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

      return policy.resolveReadPath(root);
    });
  }
}