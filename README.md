# SSH Inspector MCP

固定した1台のRHEL系hostへSSH接続し、参照操作だけを構造化MCP toolsとして提供するstdio serverです。Kiro、Claude Code/Desktop、VS Codeから同じ単一bundleを利用できます。

raw command、shell、PTY、sudo、port forwarding、agent forwarding、任意environmentは公開しません。SSH filesystemは起動設定のpath allowlistで制限し、AWS resourceはSSH先のIAMで認可します。file本文、CloudWatch Logs event、S3 object、DynamoDB itemはread-onlyでも機密情報になり得るため、metadata操作とは別toolに分離して件数・時間・byte上限を適用します。

## 必要条件

- build環境: Node.js 20以上、npm
- SSH先: OpenSSH SFTP subsystem、RHEL標準command、利用する場合はAWS CLI v2
- 認証: pin留めしたSSH host key fingerprintと、private keyまたは環境変数経由password
- AWS: SSH先にread-only IAM roleまたは最小権限credential

## Build

```bash
npm ci
npm run verify
```

配布物は [dist/ssh-inspector-mcp.mjs](dist/ssh-inspector-mcp.mjs) だけです。設定JSONと任意のAWS拡張specはbundle外で管理します。

```bash
node dist/ssh-inspector-mcp.mjs --config /absolute/path/to/config.json
```

stdioのstdoutはJSON-RPC専用です。警告と起動errorはstderrへ出力します。

## 設定

[examples/config.example.json](examples/config.example.json) を基に、host、user、host key、参照root、任意のAWS拡張spec pathを設定します。未知key、相対remote path、host key未指定、参照rootなし、上限外の値は起動時に拒否されます。

host key fingerprintは管理者から別経路で確認してください。初回接続時の値を無条件に信頼しないでください。

```bash
ssh-keyscan -t ed25519 rhel.example.internal 2>/dev/null | ssh-keygen -lf - -E sha256
```

private key認証ではlocal key fileを0600以下にします。暗号化keyのpassphraseやpasswordはJSONへ書かず、設定した環境変数名から渡します。

```json
{
  "authentication": {
    "method": "password",
    "passwordEnv": "SSH_INSPECTOR_PASSWORD"
  }
}
```

`allowAllReadablePaths` はSSH userが読める広い範囲を公開する危険なopt-inです。利用には `acknowledgeBroadReadRisk: true` が必要ですが、productionでは用途別rootを指定してください。`.ssh`、`.aws`、`/proc/*/environ` はこのmodeでも拒否します。

## Tools

| 分類 | tools |
|---|---|
| SSH/SFTP | `ssh_health_check`, `ssh_list_directory`, `ssh_read_file_head`, `ssh_read_file_tail` |
| RHEL | `ssh_find_files`, `ssh_search_text`, `ssh_system_info` |
| CodePipeline | `aws_codepipeline_list_pipelines`, `aws_codepipeline_get_pipeline_state`, `aws_codepipeline_list_pipeline_executions`, `aws_codepipeline_get_pipeline_execution`, `aws_codepipeline_list_action_executions` |
| CloudWatch | `aws_cloudwatch_describe_alarms`, `aws_cloudwatch_list_metrics`, `aws_cloudwatch_get_metric_data` |
| CloudWatch Logs metadata | `aws_cloudwatch_logs_describe_log_groups`, `aws_cloudwatch_logs_describe_log_streams` |
| CloudWatch Logs data | `aws_cloudwatch_logs_filter_log_events`, `aws_cloudwatch_logs_get_log_events` |
| S3 metadata | `aws_s3_list_buckets`, `aws_s3_list_objects`, `aws_s3_head_object` |
| S3 data | `aws_s3_get_object_text` |
| DynamoDB metadata | `aws_dynamodb_list_tables`, `aws_dynamodb_describe_table` |
| DynamoDB data | `aws_dynamodb_get_item`, `aws_dynamodb_query` |

AWS resourceとregionの参照可否はSSH先のIAM policyで制御します。S3 data toolはIAMで参照可能な無圧縮UTF-8 textだけをbyte rangeで取得します。CloudWatch Logsは最大24時間・100 events、DynamoDB queryは最大100 itemsに制限し、DynamoDB `scan` は標準toolとして公開しません。data toolsのauto-approveは推奨しません。

CodePipeline toolsは1回100件までとし、pipeline/action execution ID、status、error、外部execution IDを保持します。action configuration、artifact location、output variables、token、URLは結果から除外します。`aws_codepipeline_list_pipeline_executions` の `mode` は最新1件、失敗、全件のboundedな絞り込みを指定できます。secret-safe shapingを迂回させないため、CodePipelineは宣言的AWS拡張serviceには追加していません。

`ssh_find_files` の `modifiedAfter` はtimezone付きISO 8601日時を受け取り、固定した `find -newermt` 条件として扱います。`ssh_search_text` の `compression` は `none`、`gzip`、`bzip2`、`xz` を選択でき、圧縮時の既定globはそれぞれ `*.gz`、`*.bz2`、`*.xz` です。`includeGlob` で対象名をさらに限定できます。

`aws_cloudwatch_logs_describe_log_groups` は `logGroupNamePrefix` または `logGroupNamePattern` でlog groupを最大50件検索します。両条件は同時指定できず、続きは `nextToken` で取得します。

## AWS拡張

[examples/aws-tools.example.json](examples/aws-tools.example.json) のversion 1 specを、設定の `aws.extensionSpecPaths` へ明示指定します。directoryの自動探索はしません。

拡張はread-only operation allowlist、region形式、timeout、output bytes、型付きparameterを起動時に検証します。resource認可は標準toolと同じくIAMへ委ねます。DynamoDB `scan` は明示specで最大100の必須`limit`を宣言した場合だけ登録できます。

## Client設定

すべてのpathはabsolute pathへ置き換えてください。秘密値はclient設定の `env` か、client processを起動する環境から渡します。

### VS Code

[.vscode/mcp.json](.vscode/mcp.json) にstdio設定があります。build後、MCP server一覧から `ssh-inspector` をstartしてtool discoveryを確認できます。

### Kiro

`.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "ssh-inspector": {
      "command": "node",
      "args": ["/absolute/path/ssh-inspector-mcp.mjs", "--config", "/absolute/path/config.json"],
      "disabled": false,
      "autoApprove": [
        "ssh_health_check",
        "ssh_list_directory",
        "ssh_read_file_head",
        "ssh_read_file_tail",
        "ssh_find_files",
        "ssh_search_text",
        "ssh_system_info",
        "aws_codepipeline_list_pipelines",
        "aws_codepipeline_get_pipeline_state",
        "aws_codepipeline_list_pipeline_executions",
        "aws_codepipeline_get_pipeline_execution",
        "aws_codepipeline_list_action_executions",
        "aws_cloudwatch_describe_alarms",
        "aws_cloudwatch_list_metrics",
        "aws_cloudwatch_get_metric_data",
        "aws_cloudwatch_logs_describe_log_groups",
        "aws_cloudwatch_logs_describe_log_streams",
        "aws_cloudwatch_logs_filter_log_events",
        "aws_cloudwatch_logs_get_log_events",
        "aws_s3_list_buckets",
        "aws_s3_list_objects",
        "aws_s3_head_object",
        "aws_s3_get_object_text",
        "aws_dynamodb_list_tables",
        "aws_dynamodb_describe_table",
        "aws_dynamodb_get_item",
        "aws_dynamodb_query"
      ]
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ssh-inspector": {
      "command": "node",
      "args": ["/absolute/path/ssh-inspector-mcp.mjs", "--config", "/absolute/path/config.json"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio --scope user ssh-inspector -- node /absolute/path/ssh-inspector-mcp.mjs --config /absolute/path/config.json
```

## 運用

- hardening: [docs/rhel-hardening.md](docs/rhel-hardening.md)
- security modelとincident対応: [SECURITY.md](SECURITY.md)
- host key rotation時は新fingerprintを別経路で確認し、停止中に設定を更新する
- auditにはoperation ID、duration、終了状態を残し、秘密、file本文、AWS dataを残さない
- AWS CLI errorにはresource名が含まれる場合があるため、stderrログの閲覧権限を制限する