import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { loadConfig, resolveConfigPath } from "./config/load.js";
import { createServer } from "./server.js";

/**
 * stdioをMCPプロトコル専用に保ったままサーバーを起動します。
 */
async function main(): Promise<void> {
  const configPath = resolveConfigPath(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const server = createServer(config);
  const transport = new StdioServerTransport();

  if (config.access.allowAllReadablePaths) {
    // クライアントの承認表示だけでは情報流出を防げないため、危険設定を運用ログへ残します。
    console.error("警告: SSHユーザーが読める全パスへの参照が許可されています。");
  }

  await server.connect(transport);
}

main().catch((error: unknown) => {
  // stdoutへの出力はJSON-RPCを破壊するため、起動失敗もstderrだけへ送ります。
  console.error(error instanceof Error ? error.message : "不明な起動エラーが発生しました");
  process.exitCode = 1;
});