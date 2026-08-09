import { createHash, timingSafeEqual } from "node:crypto";

/**
 * SSHサーバーの公開鍵をOpenSSH形式のSHA-256 fingerprintへ変換します。
 *
 * @param hostKey SSH handshakeで受け取った公開鍵blob
 * @returns `SHA256:` prefixを持つfingerprint
 */
export function fingerprintHostKey(hostKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
}

/**
 * 設定済みfingerprintだけを受理するtiming-safeなhost verifierを作成します。
 *
 * @param expectedFingerprint 起動設定でpin留めされたfingerprint
 * @returns ssh2へ渡す同期verifier
 */
export function createHostVerifier(
  expectedFingerprint: string,
): (hostKey: Buffer) => boolean {
  const expected = Buffer.from(expectedFingerprint, "ascii");

  return (hostKey: Buffer): boolean => {
    const actual = Buffer.from(fingerprintHostKey(hostKey), "ascii");

    // 長さが異なる入力はtimingSafeEqualへ渡せないため、公開情報である長さだけ先に比較します。
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}