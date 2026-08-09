# Security

## Security boundary

このserverは、MCP clientから任意commandを実行できないこと、起動時に固定したSSH host/userとallowlistの外を参照できないこと、出力・時間・同時実行数を制限することをboundaryとします。

read-onlyは機密性を保証しません。file名、log本文、process情報、S3 object、DynamoDB item、CloudWatch dimensionsは機密情報を含み得ます。MCP client、model provider、conversation logへ渡る情報として扱ってください。

## 提供しない機能

- raw command、shell、PTY、sudo
- SSH agent、agent forwarding、X11、TCP/port forwarding
- 任意environment、AWS profile/endpoint、TLS検証無効化、CLI query、debug
- `file://` / `fileb://` parameter、local保存先、binary S3 download
- write系AWS operation、標準DynamoDB scan
- HTTP transport、複数host、workspaceからのspec自動探索

## Defense in depth

1. 専用SSH userを使い、OS permissionで参照範囲を絞る。
2. SSH host keyをSHA-256 fingerprintでpin留めする。
3. `allowedListRoots` と `allowedReadRoots` を用途別に最小化する。
4. S3 bucket/prefix、DynamoDB table/indexとdata flagを最小化する。
5. SSH先のAWS credentialへread-only IAM policyとresource制約を適用する。
6. data toolsをauto-approveせず、毎回resourceとrange/queryを確認する。
7. MCP clientとserver stderr/audit logの閲覧権限・保存期間を制限する。

tool schemaやbuilderのallowlistはIAMの代替ではありません。AWS側の認可を最終防衛線にしてください。

## Secret handling

password/passphraseは設定JSONやCLI引数へ書かず、環境変数から渡します。private keyはbundleへ含めず、0600以下のlocal fileとして管理します。設定、key、AWS extension specをrepositoryへcommitしないでください。

serverはstdoutへlogを出しません。stderr errorへcommand全文やcredentialを含めませんが、AWS CLI自身のstderrにresource名が含まれる可能性があります。

## Host key rotation

fingerprint不一致時は接続を継続しないでください。serverを停止し、管理者または構成管理systemから新host keyを別経路で確認し、変更理由と実施者を記録して設定を更新します。緊急回避としてhost検証を無効化する設定はありません。

## Incident response

1. MCP serverと対象clientを停止する。
2. SSH key/password、AWS credential、影響したhost accountを無効化またはrotationする。
3. MCP conversation、client log、stderr/audit、SSH auth log、CloudTrailをoperation時刻とresourceで照合する。
4. 露出したfile root、S3 prefix、DynamoDB table/itemの機密度と外部送信先を確認する。
5. allowlist、OS permission、IAM、auto-approve設定を修正してから再開する。

脆弱性報告には再現条件、影響するtool、設定の非秘密部分、期待動作を含め、credentialや実dataは添付しないでください。