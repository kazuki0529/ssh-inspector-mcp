import { posix } from "node:path";

/** SFTP realpath操作に必要な最小契約です。 */
export type ResolveRemotePath = (path: string) => Promise<string>;

/** remote pathが許可範囲外であることを表します。 */
export class PathAccessDeniedError extends Error {
  /**
   * 拒否理由を利用者へ通知できる形式で保持します。
   *
   * @param message 拒否理由
   */
  public constructor(message: string) {
    super(message);
    this.name = "PathAccessDeniedError";
  }
}

/** canonical pathの用途別allowlistを保持します。 */
export interface RemotePathPolicyOptions {
  allowedListRoots: readonly string[];
  allowedReadRoots: readonly string[];
  allowAllReadablePaths: boolean;
}

/**
 * SFTPサーバーが解決したcanonical pathに対して用途別の参照範囲を強制します。
 */
export class RemotePathPolicy {
  readonly #resolvePath: ResolveRemotePath;
  readonly #listRoots: readonly string[];
  readonly #readRoots: readonly string[];
  readonly #allowAllReadablePaths: boolean;

  private constructor(
    resolvePath: ResolveRemotePath,
    listRoots: readonly string[],
    readRoots: readonly string[],
    allowAllReadablePaths: boolean,
  ) {
    this.#resolvePath = resolvePath;
    this.#listRoots = listRoots;
    this.#readRoots = readRoots;
    this.#allowAllReadablePaths = allowAllReadablePaths;
  }

  /**
   * 設定root自身もSFTP realpathで解決し、比較基準をcanonical pathへ固定します。
   *
   * @param resolvePath SFTP realpath adapter
   * @param options 起動時に検証済みのpath設定
   * @returns 初期化済みpolicy
   */
  public static async create(
    resolvePath: ResolveRemotePath,
    options: RemotePathPolicyOptions,
  ): Promise<RemotePathPolicy> {
    const listRoots = await resolveRoots(resolvePath, options.allowedListRoots);
    const readRoots = await resolveRoots(resolvePath, options.allowedReadRoots);

    return new RemotePathPolicy(
      resolvePath,
      listRoots,
      readRoots,
      options.allowAllReadablePaths,
    );
  }

  /**
   * directory metadata参照に使うpathを解決し、list allowlist内であることを保証します。
   *
   * @param requestedPath 利用者が指定した絶対path
   * @returns 検証済みcanonical path
   */
  public async resolveListPath(requestedPath: string): Promise<string> {
    return this.#resolveAllowedPath(requestedPath, this.#listRoots, "一覧");
  }

  /**
   * file本文参照に使うpathを解決し、read allowlist内であることを保証します。
   *
   * @param requestedPath 利用者が指定した絶対path
   * @returns 検証済みcanonical path
   */
  public async resolveReadPath(requestedPath: string): Promise<string> {
    return this.#resolveAllowedPath(requestedPath, this.#readRoots, "本文参照");
  }

  /**
   * pathの形式・canonical位置・機密path拒否を一度に適用します。
   *
   * @param requestedPath 利用者入力
   * @param roots 用途別canonical root
   * @param purpose エラー表示用の用途
   * @returns 許可されたcanonical path
   */
  async #resolveAllowedPath(
    requestedPath: string,
    roots: readonly string[],
    purpose: string,
  ): Promise<string> {
    if (!posix.isAbsolute(requestedPath) || requestedPath.includes("\0")) {
      throw new PathAccessDeniedError("remote pathはNULを含まない絶対pathで指定してください");
    }

    const canonicalPath = normalizeCanonicalPath(await this.#resolvePath(requestedPath));

    if (isAlwaysDeniedPath(canonicalPath)) {
      throw new PathAccessDeniedError("認証情報またはprocess環境のpathは参照できません");
    }

    if (!this.#allowAllReadablePaths && !roots.some((root) => isWithinRoot(canonicalPath, root))) {
      throw new PathAccessDeniedError(`${purpose}が許可されたrootの外です`);
    }

    return canonicalPath;
  }
}

/**
 * root単位の境界を保ち、単なる文字列prefixによる隣接pathの誤許可を防ぎます。
 *
 * @param candidate 検査対象のcanonical path
 * @param root canonical root
 * @returns root自身または子孫ならtrue
 */
export function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || (root === "/" ? candidate.startsWith("/") : candidate.startsWith(`${root}/`));
}

/**
 * 設定rootをcanonical pathへ変換し、重複を除去します。
 *
 * @param resolvePath SFTP realpath adapter
 * @param roots 設定された絶対path
 * @returns canonical root一覧
 */
async function resolveRoots(
  resolvePath: ResolveRemotePath,
  roots: readonly string[],
): Promise<readonly string[]> {
  const canonicalRoots = await Promise.all(roots.map(async (root) => normalizeCanonicalPath(await resolvePath(root))));

  return [...new Set(canonicalRoots)];
}

/**
 * SFTP実装差による末尾slashを除き、rootだけは `/` として維持します。
 *
 * @param path realpathの結果
 * @returns 比較用canonical path
 */
function normalizeCanonicalPath(path: string): string {
  const normalized = posix.normalize(path);

  if (!posix.isAbsolute(normalized)) {
    throw new PathAccessDeniedError("SFTPサーバーが絶対pathを返しませんでした");
  }

  return normalized;
}

/**
 * broad readを有効にしてもcredentialとprocess環境だけは公開しません。
 *
 * @param path canonical path
 * @returns 常に拒否するpathならtrue
 */
function isAlwaysDeniedPath(path: string): boolean {
  return (
    /(?:^|\/)\.(?:ssh|aws)(?:\/|$)/u.test(path) ||
    /^\/proc\/(?:self|\d+)\/environ$/u.test(path)
  );
}