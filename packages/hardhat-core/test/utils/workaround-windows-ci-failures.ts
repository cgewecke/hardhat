import os from "os";

/**
 * Hardhat Network tests that involve forking are much more brittle on windows
 * for some reason, so we retry them a few times.
 */
export function workaroundWindowsCiFailures({ isFork }: { isFork: boolean }) {
  before(function () {
    if (isFork && os.type() === "Windows_NT") {
      this.retries(4);
    }
  });
}
