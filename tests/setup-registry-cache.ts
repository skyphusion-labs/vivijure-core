// Global test setup: drop the per-isolate module-discovery cache before EVERY test.
//
// WHY THIS IS A SETUP FILE AND NOT A LINE IN EACH SUITE (cf#515 defect 2). Before the seam split
// the service scan was never cached by default, so no suite could leak a registry into the next
// test and only five files bothered to reset. Caching the service scan by default makes isolation a
// REQUIREMENT for a class of 24 test files that build `MODULE_*` bindings -- and 19 of them had no
// reset. One surfaced immediately (`render-orchestrator.test.ts` served a previous test's CANCELABLE
// module to a case that installs a non-cancelable one, because the cache keys on the binding-NAME
// set and those tests reuse names with different manifests). The other 18 were not proven either
// way, which is the worse state.
//
// Patching 19 files would be vigilance and would drift on the 25th. This hook cannot be forgotten by
// a future test author, and it makes the isolation property structural rather than remembered.
import { beforeEach } from "vitest";
import { _resetModuleDiscoveryCache } from "../src/modules/registry.js";

beforeEach(() => {
  _resetModuleDiscoveryCache();
});
