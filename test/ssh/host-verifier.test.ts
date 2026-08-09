import { describe, expect, it } from "vitest";

import {
  createHostVerifier,
  fingerprintHostKey,
} from "../../src/ssh/host-verifier.js";

describe("createHostVerifier", () => {
  it("pin留めされた公開鍵だけを受理する", () => {
    const hostKey = Buffer.from("test-host-key");
    const verifier = createHostVerifier(fingerprintHostKey(hostKey));

    expect(verifier(hostKey)).toBe(true);
    expect(verifier(Buffer.from("another-host-key"))).toBe(false);
  });
});