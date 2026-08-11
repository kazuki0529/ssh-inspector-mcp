import type { Readable } from "node:stream";

import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";

/** directory entryで公開するfile種別です。 */
export type RemoteFileType = "directory" | "file" | "symlink" | "other";

/** SFTP directory entryのtransport非依存表現です。 */
export interface RemoteDirectoryEntry {
  name: string;
  type: RemoteFileType;
  size: number;
  modifiedAt: string;
  mode: string;
}

/** SFTP stat結果のtransport非依存表現です。 */
export interface RemoteFileStat {
  size: number;
  isFile: boolean;
  type?: RemoteFileType | undefined;
  modifiedAt?: string | undefined;
  mode?: string | undefined;
}

/** SFTP操作が中断されたことを表します。 */
export class SftpOperationAbortedError extends Error {
  /** 中断理由を固定して生成します。 */
  public constructor() {
    super("SFTP操作がtimeoutにより中断されました");
    this.name = "SftpOperationAbortedError";
  }
}

/** tool serviceが利用するSFTP操作の最小契約です。 */
export interface RemoteFileSystem {
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<readonly RemoteDirectoryEntry[]>;
  stat(path: string): Promise<RemoteFileStat>;
  readRange(path: string, start: number, maxBytes: number, signal: AbortSignal): Promise<Buffer>;
  close(): void;
}

/**
 * callback中心のssh2 SFTP APIをboundedなPromise APIへ変換します。
 */
export class Ssh2RemoteFileSystem implements RemoteFileSystem {
  readonly #sftp: SFTPWrapper;
  #closed = false;

  /**
   * operation専用に開いたSFTP channelを保持します。
   *
   * @param sftp ssh2 SFTP channel
   */
  public constructor(sftp: SFTPWrapper) {
    this.#sftp = sftp;
  }

  /** @inheritdoc */
  public async realpath(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.#sftp.realpath(path, (error, absolutePath) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(absolutePath);
      });
    });
  }

  /** @inheritdoc */
  public async readdir(path: string): Promise<readonly RemoteDirectoryEntry[]> {
    const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      this.#sftp.readdir(path, (error, list) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(list);
      });
    });

    return entries.map((entry) => mapDirectoryEntry(entry));
  }

  /** @inheritdoc */
  public async stat(path: string): Promise<RemoteFileStat> {
    const stats = await new Promise<Stats>((resolve, reject) => {
      this.#sftp.stat(path, (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    });

    return {
      size: stats.size,
      isFile: stats.isFile(),
      type: detectFileType(stats),
      modifiedAt: new Date(stats.mtime * 1_000).toISOString(),
      mode: (stats.mode & 0o7777).toString(8).padStart(4, "0"),
    };
  }

  /** @inheritdoc */
  public async readRange(
    path: string,
    start: number,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (maxBytes === 0) {
      return Buffer.alloc(0);
    }

    const stream = this.#sftp.createReadStream(path, {
      start,
      end: start + maxBytes - 1,
      autoClose: true,
    });

    return collectStream(stream, maxBytes, signal);
  }

  /** @inheritdoc */
  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#sftp.end();
  }
}

/**
 * SFTP streamをbyte上限内で収集し、AbortSignalをchannel中断へ反映します。
 *
 * @param stream ssh2 read stream
 * @param maxBytes 最大収集byte数
 * @param signal timeout通知
 * @returns 収集したbuffer
 */
async function collectStream(
  stream: Readable,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const abort = (): void => {
      stream.destroy(new SftpOperationAbortedError());
    };

    signal.addEventListener("abort", abort, { once: true });
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - total;

      if (remaining <= 0) {
        return;
      }

      const accepted = buffer.subarray(0, remaining);
      chunks.push(accepted);
      total += accepted.length;
    });
    stream.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    stream.once("end", () => {
      signal.removeEventListener("abort", abort);
      resolve(Buffer.concat(chunks, total));
    });
  });
}

/**
 * ssh2固有のStatsを、MCP出力で安定した値へ変換します。
 *
 * @param entry ssh2 directory entry
 * @returns transport非依存entry
 */
function mapDirectoryEntry(entry: FileEntryWithStats): RemoteDirectoryEntry {
  return {
    name: entry.filename,
    type: detectFileType(entry.attrs),
    size: entry.attrs.size,
    modifiedAt: new Date(entry.attrs.mtime * 1_000).toISOString(),
    mode: (entry.attrs.mode & 0o7777).toString(8).padStart(4, "0"),
  };
}

/**
 * file type判定を一か所に閉じ、未知typeを通常fileとして誤表示しません。
 *
 * @param stats ssh2 stat
 * @returns 公開用file種別
 */
function detectFileType(stats: Stats): RemoteFileType {
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}