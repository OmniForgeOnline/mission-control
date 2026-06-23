import {
  fingerprintRemediationError,
  REMEDIATION_STAGNATION_LIMIT,
  shouldStopRemediation
} from "../src/daemon/remediation.ts";

describe("task-scoped remediation", () => {
  it("does not cap remediation at three attempts", () => {
    expect(shouldStopRemediation(3, 1)).toBe(false);
    expect(shouldStopRemediation(10, 2)).toBe(false);
  });

  it("stops when the same failure repeats without progress", () => {
    expect(shouldStopRemediation(4, REMEDIATION_STAGNATION_LIMIT)).toBe(true);
  });

  it("fingerprints errors without line-number noise", () => {
    const a = fingerprintRemediationError("tests/foo.ts:10:3 error unused var");
    const b = fingerprintRemediationError("tests/foo.ts:12:8 error unused var");
    expect(a).toBe(b);
  });

});
