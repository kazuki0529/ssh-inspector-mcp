import { randomUUID } from "node:crypto";

/**
 * operation metadataと安全なMCP error形式をtoolへ一貫して適用します。
 *
 * @param operation tool本体
 * @returns textとstructured contentを持つMCP tool result
 */
export async function executeTool<Result extends object>(operation: () => Promise<Result>) {
  const operationId = randomUUID();
  const startedAt = performance.now();

  try {
    const data = await operation();
    const result = {
      operationId,
      durationMs: Math.round(performance.now() - startedAt),
      data,
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    const result = {
      operationId,
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : "不明なoperationエラーが発生しました",
    };

    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }
}