import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { CodePipelineCommandBuilder, CodePipelineService } from "./aws/codepipeline.js";
import { CloudWatchCommandBuilder, CloudWatchService } from "./aws/cloudwatch.js";
import {
  CloudWatchLogsCommandBuilder,
  CloudWatchLogsService,
} from "./aws/cloudwatch-logs.js";
import { S3CommandBuilder, S3Service } from "./aws/s3.js";
import { DynamoDbCommandBuilder, DynamoDbService } from "./aws/dynamodb.js";
import { loadAwsToolSpecs } from "./aws/load-specs.js";
import { loadConfig, resolveConfigPath } from "./config/load.js";
import { createServer } from "./server.js";
import { SshClient } from "./ssh/client.js";
import { FindFilesService } from "./tools/find-files.js";
import { SearchTextService } from "./tools/search-text.js";
import { SftpInspector } from "./tools/sftp-inspector.js";
import { SystemInfoService } from "./tools/system-info.js";

/**
 * stdioをMCPプロトコル専用に保ったままサーバーを起動します。
 */
async function main(): Promise<void> {
  const configPath = resolveConfigPath(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const extensionSpecs = await loadAwsToolSpecs(config);
  const sshClient = new SshClient(config);
  const sftpInspector = new SftpInspector(sshClient, config);
  const server = createServer(config, {
    sftpInspector,
    rhel: {
      findFiles: new FindFilesService(sshClient, sshClient, config),
      searchText: new SearchTextService(sshClient, sshClient, config),
      systemInfo: new SystemInfoService(sshClient, config),
    },
    codePipeline: new CodePipelineService(sshClient, new CodePipelineCommandBuilder()),
    cloudWatch: new CloudWatchService(sshClient, new CloudWatchCommandBuilder()),
    cloudWatchLogs: new CloudWatchLogsService(
      sshClient,
      new CloudWatchLogsCommandBuilder(),
    ),
    s3: new S3Service(sshClient, new S3CommandBuilder(), config),
    dynamodb: new DynamoDbService(sshClient, new DynamoDbCommandBuilder()),
    extensionRunner: sshClient,
    extensionSpecs,
  });
  const transport = new StdioServerTransport();

  if (config.access.allowAllReadablePaths) {
    // クライアントの承認表示だけでは情報流出を防げないため、危険設定を運用ログへ残します。
    console.error("警告: SSHユーザーが読める全パスへの参照が許可されています。");
  }

  const close = (): void => {
    sshClient.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  await server.connect(transport);
}

main().catch((error: unknown) => {
  // stdoutへの出力はJSON-RPCを破壊するため、起動失敗もstderrだけへ送ります。
  console.error(error instanceof Error ? error.message : "不明な起動エラーが発生しました");
  process.exitCode = 1;
});