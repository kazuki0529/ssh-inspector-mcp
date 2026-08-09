import { readFile, stat } from "node:fs/promises";

import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";

import type { AppConfig } from "../config/schema.js";
import {
  executeRemoteCommand,
  type CommandExecutionOptions,
  type CommandExecutionResult,
  type RemoteCommandRunner,
} from "../execution/executor.js";
import { OperationLimiter } from "../execution/limits.js";
import type { RemoteCommand } from "../execution/render-command.js";
import { createHostVerifier } from "./host-verifier.js";
import { Ssh2RemoteFileSystem, type RemoteFileSystem } from "./sftp.js";

type SshConfig = AppConfig["ssh"];

/** SSH clientが接続またはchannelを確立できないことを表します。 */
export class SshConnectionError extends Error {
  /**
   * 秘密情報を含まない理由と元例外を保持します。
   *
   * @param message 利用者へ表示可能な理由
   * @param cause transportの元例外
   */
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SshConnectionError";
  }
}

/** SFTP operationを実行する接続境界です。 */
export interface SftpSessionProvider {
  withSftp<Result>(
    operation: (fileSystem: RemoteFileSystem, signal: AbortSignal) => Promise<Result>,
  ): Promise<Result>;
}

/**
 * 1台に固定したSSH接続をlazyに確立し、boundedなSFTP channelだけを公開します。
 */
export class SshClient implements SftpSessionProvider, RemoteCommandRunner {
  readonly #config: SshConfig;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #operationTimeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #limiter: OperationLimiter;
  #client: Client | undefined;
  #connecting: Promise<Client> | undefined;

  /**
   * 検証済み設定から接続policyを固定します。秘密は必要になるまで環境変数から読みません。
   *
   * @param config 検証済み起動設定
   * @param environment 認証情報を参照する環境変数
   */
  public constructor(config: AppConfig, environment: NodeJS.ProcessEnv = process.env) {
    this.#config = config.ssh;
    this.#environment = environment;
    this.#operationTimeoutMs = config.limits.operationTimeoutMs;
    this.#maxOutputBytes = config.limits.maxOutputBytes;
    this.#limiter = new OperationLimiter(config.limits.maxConcurrentOperations);
  }

  /** @inheritdoc */
  public async withSftp<Result>(
    operation: (fileSystem: RemoteFileSystem, signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    return this.#limiter.run(async () => {
      const client = await this.#getClient();
      const sftp = await openSftp(client);
      const fileSystem = new Ssh2RemoteFileSystem(sftp);
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
        fileSystem.close();
      }, this.#operationTimeoutMs);

      try {
        return await Promise.race([
          operation(fileSystem, controller.signal),
          rejectWhenAborted(controller.signal),
        ]);
      } finally {
        clearTimeout(timeout);
        fileSystem.close();
      }
    });
  }

  /** @inheritdoc */
  public async execute(
    command: RemoteCommand,
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    return this.#limiter.run(async () => {
      const client = await this.#getClient();

      return executeRemoteCommand(
        client,
        command,
        Math.min(options.maxOutputBytes ?? this.#maxOutputBytes, this.#maxOutputBytes),
        Math.min(options.timeoutMs ?? this.#operationTimeoutMs, this.#operationTimeoutMs),
      );
    });
  }

  /** 現在のSSH接続を閉じ、次回operationを再接続させます。 */
  public close(): void {
    this.#client?.end();
    this.#client = undefined;
  }

  /**
   * 並行する初回operationが同じ接続試行を共有するようにします。
   *
   * @returns ready状態のssh2 client
   */
  async #getClient(): Promise<Client> {
    if (this.#client) {
      return this.#client;
    }

    this.#connecting ??= this.#connect();

    try {
      return await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  /**
   * 許可された認証方式だけを指定し、host key検証成功後の接続を保持します。
   *
   * @returns ready状態のssh2 client
   */
  async #connect(): Promise<Client> {
    const options = await buildConnectConfig(this.#config, this.#environment);
    const client = new Client();

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        client.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        client.off("ready", onReady);
        reject(new SshConnectionError("SSH接続を確立できません", error));
      };

      client.once("ready", onReady);
      client.once("error", onError);
      client.connect(options);
    });

    this.#client = client;
    client.once("close", () => {
      if (this.#client === client) {
        this.#client = undefined;
      }
    });
    client.on("error", (error) => {
      // 接続後のtransport errorを握り潰すと障害調査不能になるため、秘密を含まないmessageだけ残します。
      console.error(`SSH接続エラー: ${error.message}`);
    });

    return client;
  }
}

/**
 * 認証秘密をファイルまたは環境変数から取得し、ssh2 optionを固定生成します。
 *
 * @param config 検証済みSSH設定
 * @param environment 認証秘密の参照元
 * @returns shellやforwardingを含まない接続option
 */
async function buildConnectConfig(
  config: SshConfig,
  environment: NodeJS.ProcessEnv,
): Promise<ConnectConfig> {
  const common: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: config.readyTimeoutMs,
    hostVerifier: createHostVerifier(config.hostKeySha256),
    tryKeyboard: false,
    agentForward: false,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
  };

  if (config.authentication.method === "password") {
    return {
      ...common,
      password: requireEnvironmentValue(environment, config.authentication.passwordEnv),
      authHandler: ["password"],
    };
  }

  await assertPrivateKeyPermissions(config.authentication.privateKeyPath);
  const privateKey = await readFile(config.authentication.privateKeyPath);
  const passphrase = config.authentication.passphraseEnv
    ? requireEnvironmentValue(environment, config.authentication.passphraseEnv)
    : undefined;

  return {
    ...common,
    privateKey,
    ...(passphrase === undefined ? {} : { passphrase }),
    authHandler: ["publickey"],
  };
}

/**
 * private keyがPOSIX上でgroup/otherへ公開されていないことを確認します。
 *
 * @param path local private key path
 */
async function assertPrivateKeyPermissions(path: string): Promise<void> {
  const keyStat = await stat(path);

  if (!keyStat.isFile()) {
    throw new SshConnectionError("SSH秘密鍵pathが通常fileではありません");
  }

  if (process.platform !== "win32" && (keyStat.mode & 0o077) !== 0) {
    throw new SshConnectionError("SSH秘密鍵の権限を0600以下に制限してください");
  }
}

/**
 * 起動時検査後に削除された環境変数もfail closedで扱います。
 *
 * @param environment 環境変数
 * @param name 参照する変数名
 * @returns 空でない秘密値
 */
function requireEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) {
    throw new SshConnectionError(`SSH認証環境変数が設定されていません: ${name}`);
  }
  return value;
}

/**
 * ssh2 callbackをPromiseへ変換し、channel確立失敗を安全な例外へ変換します。
 *
 * @param client ready状態のssh2 client
 * @returns operation専用SFTP channel
 */
async function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(new SshConnectionError("SFTP channelを開始できません", error));
        return;
      }
      resolve(sftp);
    });
  });
}

/**
 * AbortSignalをrace可能なrejectへ変換し、timeoutを利用者へ通知します。
 *
 * @param signal operation timeout signal
 * @returns abort時だけrejectするPromise
 */
async function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(new SshConnectionError("SSH operationがtimeoutしました"));
      },
      { once: true },
    );
  });
}