import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { appConfigSchema, type AppConfig } from "./schema.js";

/**
 * 起動設定を読み込めなかったことを、内部例外の詳細を保ったまま通知します。
 */
export class ConfigLoadError extends Error {
  /**
   * 利用者へ表示可能な文脈と原因を保持します。
   *
   * @param message 設定読込に失敗した理由
   * @param cause 元になった例外
   */
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ConfigLoadError";
  }
}

/**
 * CLI引数から設定ファイルの絶対パスを確定します。
 *
 * 意図しない引数を黙って受け入れないため、`--config` 以外は拒否します。
 *
 * @param argv Node.jsへ渡された引数
 * @returns 解決済みの設定ファイルパス
 */
export function resolveConfigPath(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--config" || !argv[1]) {
    throw new ConfigLoadError("使用方法: ssh-inspector-mcp --config <設定ファイル>");
  }

  return resolve(argv[1]);
}

/**
 * JSON設定を検証し、認証に必要な環境変数が利用可能か確認します。
 *
 * @param configPath 設定ファイルのパス
 * @param environment MCPプロセスへ許可された環境変数
 * @returns 検証済み設定
 */
export async function loadConfig(
  configPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AppConfig> {
  try {
    const source = await readFile(configPath, "utf8");
    const config = appConfigSchema.parse(JSON.parse(source) as unknown);

    validateCredentialEnvironment(config, environment);

    return config;
  } catch (error) {
    if (error instanceof ConfigLoadError) {
      throw error;
    }

    throw new ConfigLoadError(`設定ファイルを読み込めません: ${configPath}`, error);
  }
}

/**
 * 認証情報を設定ファイルへ埋め込まずに済むよう、参照先の存在だけを起動時に確認します。
 *
 * @param config 検証済み設定
 * @param environment MCPプロセスへ許可された環境変数
 */
function validateCredentialEnvironment(
  config: AppConfig,
  environment: NodeJS.ProcessEnv,
): void {
  const authentication = config.ssh.authentication;

  if (authentication.method === "password" && !environment[authentication.passwordEnv]) {
    throw new ConfigLoadError(
      `SSHパスワード環境変数が設定されていません: ${authentication.passwordEnv}`,
    );
  }

  if (
    authentication.method === "privateKey" &&
    authentication.passphraseEnv &&
    !environment[authentication.passphraseEnv]
  ) {
    throw new ConfigLoadError(
      `秘密鍵passphrase環境変数が設定されていません: ${authentication.passphraseEnv}`,
    );
  }
}