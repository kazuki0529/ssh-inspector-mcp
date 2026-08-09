import { describe, expect, it } from "vitest";

import { OperationLimiter } from "../../src/execution/limits.js";

describe("OperationLimiter", () => {
  it("最大同時実行数を超えず待機operationをFIFOで開始する", async () => {
    const limiter = new OperationLimiter(2);
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const operations = [1, 2, 3].map(async (identifier) =>
      limiter.run(async () => {
        started.push(identifier);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      }),
    );

    await viWaitFor(() => releases.length === 2);
    expect(started).toEqual([1, 2]);

    releases[0]?.();
    await viWaitFor(() => releases.length === 3);
    expect(started).toEqual([1, 2, 3]);

    releases[1]?.();
    releases[2]?.();
    await Promise.all(operations);
  });
});

/**
 * timerへ依存せずmicrotask進行だけで非同期条件を待ちます。
 *
 * @param condition 完了条件
 */
async function viWaitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("非同期条件が成立しませんでした");
}