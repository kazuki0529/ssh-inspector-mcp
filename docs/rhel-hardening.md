# RHEL hardening

## 専用account

interactive作業と共有しない専用userを作成し、参照対象groupだけを付与します。root、wheel、sudoersへ追加しません。home、`.ssh`、設定file、logのpermissionを定期監査します。

SFTPと固定command executionの両方を使うため、`ForceCommand internal-sftp` は利用できません。forced command wrapperを導入する場合は、SFTP subsystem要求と、このserverが生成する固定absolute commandだけを厳密にdispatchする独立security componentとして実装・監査してください。

## authorized_keys

public key行へOpenSSHの`restrict` optionを付け、forwarding、PTY、X11、user rcを無効化します。

```text
restrict ssh-ed25519 AAAAC3... ssh-inspector
```

server全体または`Match User`でも防御します。環境に合わせて変更し、`sshd -t` で検証してからreloadしてください。

```text
Match User ssh-inspector
    AllowAgentForwarding no
    AllowTcpForwarding no
    PermitTTY no
    PermitTunnel no
    PermitUserEnvironment no
    X11Forwarding no
```

password認証が不要なら無効化し、鍵認証を使用します。鍵を暗号化する場合、passphraseはMCP client processの環境変数から渡します。

## File permission

- `allowedListRoots` はfile名とmetadataの開示範囲です。
- `allowedReadRoots` は本文開示範囲です。list rootより狭くします。
- ACLとgroup permissionで同じ範囲をOS側でも制限します。
- symlinkはSFTP `realpath`後に再検査されますが、不要なsymlinkを許可root内へ置かないでください。
- `/proc`、home、credential directoryを広いrootに含めないでください。

SELinuxはenforcingのまま運用します。このserverのために広いallow ruleやpermissive domainを追加せず、参照対象の既存labelと最小permissionを使います。

## Command availability

RHEL toolは次のabsolute pathを前提とします。

```text
/usr/bin/find /usr/bin/grep /usr/bin/rpm /usr/bin/uname /usr/bin/uptime
/usr/bin/df /usr/bin/free /usr/bin/ps /usr/bin/systemctl /usr/bin/aws
/usr/bin/zgrep /usr/bin/bzgrep /usr/bin/xzgrep
```

PATHやshell aliasには依存しません。圧縮検索を使う場合は対象形式のgrep wrapper packageを導入します。package更新でpathやCLI behaviorが変わる場合はstagingでtestします。

本文検索は通常fileを含めて固定`find -exec`から対応grepを呼び出します。利用者入力はpath・日時・glob・patternの独立argvとして渡されますが、広いrootや深い`maxDepth`はI/O負荷を増やすため、許可rootとserver timeoutを開発環境のlog配置に合わせて絞ります。

## AWS credential

instance profileなど短命credentialを優先し、SSH userのhomeへ長期access keyを保存しません。CloudTrailを有効化し、IAM policyではactionだけでなくregion、CloudWatch Logs log group、bucket/prefix、table ARN、index ARNを制限します。AWS resourceの参照可否はserver設定ではなく、このIAM policyだけで認可されます。

CloudWatch Logs event、S3 object本文、DynamoDB itemを許可しない環境では、対応するread actionをIAM policyへ含めません。CLI policyを迂回されてもwriteできないよう、write actionも含めません。

## Audit

`sshd` authentication log、MCP server stderr、任意の外部audit sink、CloudTrailの時刻を同期します。本文、query値、password、private keyは記録せず、operation ID、tool名、duration、終了状態、truncationだけを記録します。

大量の拒否、timeout、host key不一致、未知のextension spec変更をalert対象にします。