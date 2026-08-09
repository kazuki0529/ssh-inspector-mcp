/** 同時実行上限に空きがないことを内部的に表す待機処理です。 */
type ReleaseSlot = () => void;

/**
 * SSH session数を増やさず、同一接続上のoperation同時実行数を制限します。
 */
export class OperationLimiter {
  readonly #maximum: number;
  readonly #waiting: Array<(release: ReleaseSlot) => void> = [];
  #active = 0;

  /**
   * 最大同時実行数を固定します。
   *
   * @param maximum 最大同時実行数
   */
  public constructor(maximum: number) {
    this.#maximum = maximum;
  }

  /**
   * 空きslotを取得してoperationを実行し、完了時に必ず解放します。
   *
   * @param operation 制限対象の非同期処理
   * @returns operationの結果
   */
  public async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const release = await this.#acquire();

    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * FIFOでslotを割り当て、特定toolの連続呼出しによる飢餓を避けます。
   *
   * @returns slot解放関数
   */
  async #acquire(): Promise<ReleaseSlot> {
    if (this.#active < this.#maximum) {
      this.#active += 1;
      return this.#createRelease();
    }

    return new Promise((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  /**
   * 二重解放を無視し、次の待機operationへslotを直接引き渡します。
   *
   * @returns 一度だけ有効な解放関数
   */
  #createRelease(): ReleaseSlot {
    let released = false;

    return (): void => {
      if (released) {
        return;
      }
      released = true;

      const next = this.#waiting.shift();
      if (next) {
        next(this.#createRelease());
        return;
      }

      this.#active -= 1;
    };
  }
}