# SSH Inspector MCP 開発指針

- MCP TypeScript SDK v2 の公式文書を基準にする: https://ts.sdk.modelcontextprotocol.io/v2/
- MCP仕様は最新の公式仕様を基準にする: https://modelcontextprotocol.io/specification/latest
- stdio transport の stdout はJSON-RPC専用とし、ログはstderrへ出力する。
- raw command、shell、PTY、sudo、port forwarding、agent forwardingを公開しない。
- 公開APIと複雑な内部helperには日本語JSDocを記述する。
- コメントは判断理由を示すWHYだけを日本語で記述し、処理の逐語説明は書かない。
- validation、policy、I/O、result shapingのまとまりの間には空行を入れる。
- SOLIDを責務境界に適用し、KISS・YAGNIを優先する。セキュリティ検証だけを慎重にDRY化する。