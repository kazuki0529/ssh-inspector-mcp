import { TextDecoder } from "node:util";

import type { AppConfig } from "../config/schema.js";
import type { SftpSessionProvider } from "../ssh/client.js";
import { RemotePathPolicy } from "../ssh/path-policy.js";
import type { RemoteDirectoryEntry, RemoteFileSystem, RemoteFileType } from "../ssh/sftp.js";

/** directory listing結果です。 */
export interface DirectoryListing {
  path: string;
  entries: readonly RemoteDirectoryEntry[];
  truncated: boolean;
}

/** bounded file本文参照結果です。 */
export interface FileSegment {
  path: string;
  text: string;
  bytesRead: number;
  truncated: boolean;
}

/** canonical pathで取得したfile metadataです。 */
export interface FileMetadata {
  requestedPath: string;
  path: string;
  symlinkResolved: boolean;
  type: RemoteFileType;
  size: number;
  modifiedAt: string | null;
  mode: string | null;
}

/** bounded line range参照結果です。 */
export interface FileLineRange extends FileSegment {
  startLine: number;
  linesRead: number;
}

/**
 * SFTP参照操作をpath policyとserver limitの内側へ閉じ込めます。
 */
export class SftpInspector {
  readonly #sessions: SftpSessionProvider;
  readonly #config: AppConfig;

  /**
   * transportと検証済みpolicyを結合します。
   *
   * @param sessions SFTP session provider
   * @param config 検証済み起動設定
   */
  public constructor(sessions: SftpSessionProvider, config: AppConfig) {
    this.#sessions = sessions;
    this.#config = config;
  }

  /** SSH/SFTP疎通を確認し、remote rootのcanonical pathを返します。 */
  public async healthCheck(): Promise<{ canonicalRoot: string }> {
    return this.#sessions.withSftp(async (fileSystem) => ({
      canonicalRoot: await fileSystem.realpath("/"),
    }));
  }

  /**
   * 許可root内のdirectory metadataを上限件数まで返します。
   *
   * @param path 一覧対象のremote path
   * @param includeHidden dotfileを含めるか
   * @param limit 呼出し側が要求する最大件数
   * @returns bounded listing
   */
  public async listDirectory(
    path: string,
    includeHidden: boolean,
    limit: number,
  ): Promise<DirectoryListing> {
    return this.#sessions.withSftp(async (fileSystem) => {
      const policy = await this.#createPathPolicy(fileSystem);
      const canonicalPath = await policy.resolveListPath(path);
      const entries = (await fileSystem.readdir(canonicalPath))
        .filter((entry) => includeHidden || !entry.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name));
      const maximum = Math.min(limit, this.#config.limits.maxResults);

      return {
        path: canonicalPath,
        entries: entries.slice(0, maximum),
        truncated: entries.length > maximum,
      };
    });
  }

  /**
   * 許可list root内のpathをcanonicalizeし、本文を含まないmetadataを返します。
   *
   * @param path metadata取得対象
   * @returns canonical pathと安定したstat情報
   */
  public async getFileMetadata(path: string): Promise<FileMetadata> {
    return this.#sessions.withSftp(async (fileSystem) => {
      const policy = await this.#createPathPolicy(fileSystem);
      const canonicalPath = await policy.resolveListPath(path);
      const stat = await fileSystem.stat(canonicalPath);

      return {
        requestedPath: path,
        path: canonicalPath,
        symlinkResolved: path !== canonicalPath,
        type: stat.type ?? (stat.isFile ? "file" : "other"),
        size: stat.size,
        modifiedAt: stat.modifiedAt ?? null,
        mode: stat.mode ?? null,
      };
    });
  }

  /**
   * 許可root内のtext file先頭をline/byte上限内で返します。
   *
   * @param path 対象remote file
   * @param lines 最大line数
   * @returns bounded text segment
   */
  public async readHead(path: string, lines: number): Promise<FileSegment> {
    return this.#readSegment(path, lines, "head");
  }

  /**
   * 許可root内のtext file末尾をline/byte上限内で返します。
   *
   * @param path 対象remote file
   * @param lines 最大line数
   * @returns bounded text segment
   */
  public async readTail(path: string, lines: number): Promise<FileSegment> {
    return this.#readSegment(path, lines, "tail");
  }

  /**
   * 許可read root内のtext fileを先頭からbounded scanし、指定line範囲を返します。
   *
   * @param path 対象remote file
   * @param startLine 1始まりの開始line
   * @param lines 最大line数
   * @returns bounded line range
   */
  public async readRange(path: string, startLine: number, lines: number): Promise<FileLineRange> {
    return this.#sessions.withSftp(async (fileSystem, signal) => {
      const policy = await this.#createPathPolicy(fileSystem);
      const canonicalPath = await policy.resolveReadPath(path);
      const fileStat = await fileSystem.stat(canonicalPath);

      if (!fileStat.isFile) {
        throw new Error("通常fileだけを本文参照できます");
      }

      const scanBytes = Math.min(fileStat.size, this.#config.limits.maxReadScanBytes);
      const buffer = await fileSystem.readRange(canonicalPath, 0, scanBytes, signal);
      const text = decodeUtf8Boundary(buffer, "head");
      const allLines = splitLines(text);
      const startIndex = startLine - 1;
      if (startIndex >= allLines.length && fileStat.size > buffer.length) {
        throw new Error("startLineが最大走査byte範囲内にありません");
      }

      const maximumLines = Math.min(lines, this.#config.limits.maxReadLines);
      const selected = allLines.slice(startIndex, startIndex + maximumLines);

      return {
        path: canonicalPath,
        text: selected.join(""),
        bytesRead: buffer.length,
        startLine,
        linesRead: selected.length,
        truncated: fileStat.size > buffer.length || startIndex + selected.length < allLines.length,
      };
    });
  }

  /**
   * head/tailで共有するbinary判定・UTF-8境界補正・limit適用を実行します。
   *
   * @param path 対象remote file
   * @param lines 最大line数
   * @param direction 読取方向
   * @returns bounded text segment
   */
  async #readSegment(
    path: string,
    lines: number,
    direction: "head" | "tail",
  ): Promise<FileSegment> {
    return this.#sessions.withSftp(async (fileSystem, signal) => {
      const policy = await this.#createPathPolicy(fileSystem);
      const canonicalPath = await policy.resolveReadPath(path);
      const fileStat = await fileSystem.stat(canonicalPath);

      if (!fileStat.isFile) {
        throw new Error("通常fileだけを本文参照できます");
      }

      const maximumBytes = Math.min(fileStat.size, this.#config.limits.maxOutputBytes);
      const start = direction === "tail" ? Math.max(0, fileStat.size - maximumBytes) : 0;
      const buffer = await fileSystem.readRange(canonicalPath, start, maximumBytes, signal);
      const text = decodeUtf8Boundary(buffer, direction);
      const maximumLines = Math.min(lines, this.#config.limits.maxReadLines);
      const selectedText = selectLines(text, maximumLines, direction);

      return {
        path: canonicalPath,
        text: selectedText,
        bytesRead: buffer.length,
        truncated: fileStat.size > buffer.length || selectedText.length < text.length,
      };
    });
  }

  /**
   * operationごとにrootも再解決し、長時間接続中のsymlink変更をpolicyへ反映します。
   *
   * @param fileSystem 現在のSFTP channel
   * @returns channelに結び付いたpath policy
   */
  async #createPathPolicy(fileSystem: RemoteFileSystem): Promise<RemotePathPolicy> {
    return RemotePathPolicy.create(fileSystem.realpath.bind(fileSystem), {
      allowedListRoots: this.#config.access.allowedListRoots,
      allowedReadRoots: this.#config.access.allowedReadRoots,
      allowAllReadablePaths: this.#config.access.allowAllReadablePaths,
    });
  }
}

/**
 * NULと不正UTF-8をbinaryとして拒否し、byte上限で切れた文字だけ最大3byte補正します。
 *
 * @param buffer SFTPから取得したbounded bytes
 * @param boundary 調整してよい境界
 * @returns 検証済みUTF-8 text
 */
export function decodeUtf8Boundary(buffer: Buffer, boundary: "head" | "tail"): string {
  if (buffer.includes(0)) {
    throw new Error("binary fileは本文参照できません");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim += 1) {
    const candidate = boundary === "head" ? buffer.subarray(0, buffer.length - trim) : buffer.subarray(trim);

    try {
      return decoder.decode(candidate);
    } catch {
      // byte上限がmultibyte文字を分断する場合だけを救済し、4byte超の不正列は最終的に拒否します。
    }
  }

  throw new Error("UTF-8以外のfileは本文参照できません");
}

/**
 * 改行を保持しながら先頭または末尾の指定line数を選択します。
 *
 * @param text UTF-8検証済みtext
 * @param maximumLines 最大line数
 * @param direction 選択方向
 * @returns bounded line text
 */
export function selectLines(
  text: string,
  maximumLines: number,
  direction: "head" | "tail",
): string {
  const matches = splitLines(text);
  const selected = direction === "head" ? matches.slice(0, maximumLines) : matches.slice(-maximumLines);

  return selected.join("");
}

/**
 * 改行を保持したline配列へ分割します。
 *
 * @param text UTF-8 text
 * @returns 空の終端matchを除いたline配列
 */
function splitLines(text: string): string[] {
  return [...text.matchAll(/.*(?:\n|$)/gu)]
    .map((match) => match[0])
    .filter((line) => line.length > 0);
}