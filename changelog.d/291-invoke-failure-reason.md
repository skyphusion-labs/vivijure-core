### Added

- **Module contract: a machine-readable fault class on the `/invoke` failure arm (core#291).**
  `InvokeResponse`'s failure arm gains `reason?: InvokeFailureReason`, a closed union of eleven
  classes with an enumerable `INVOKE_FAILURE_REASONS` and a total `INVOKE_FAILURE_DISPOSITION` map
  over it. `error` stays required and human-readable; `reason` is what a monitor, a job log and a
  test read. OPTIONAL and additive: no `MODULE_API` bump, same class of change as `jobId` (#318)
  and `PollResponse.outcome` (local#304), so a module returning only prose today keeps passing
  conformance unchanged.

  Until now the failure arm had ONE channel, so the core regexed English to decide whether to retry
  a render step: `classifyTransientFailure` matches HTTP status substrings, `unreachable|timeout|
  network|econnreset|fetch failed`, `7003` and `high load|please try again later`. A module that
  reworded its message changed a retry decision it never knew it was making. The new
  `classifyInvokeFailure` prefers the declared class and never inspects the sentence when one is
  present; the two motion-submit call sites in `render-orchestrator` now use it.

  Every class is derived from a failure this repo already produces, cited on the member, and the
  test asserts that the declared disposition AGREES with what the prose classifier decides for the
  real string -- so adopting `reason` changes no render's behaviour on day one.

  **Absence is not a fault class.** `reason` is optional and deliberately NOT defaulted, and there
  is no `"unknown"` member: absent means only "this module has not adopted the field", and a
  consumer reading an absent value takes the legacy prose path. A MALFORMED value is a third state
  and fails `checkInvokeResponse`, the same strict-gate / permissive-loader split `participation`
  uses. The conformance detail names the unadopted case in words, so non-adoption is visible in a
  report rather than inferred from a green check that would otherwise look identical.

### Fixed

- **`src/modules/types.ts` and `src/modules/conformance.ts` said `/1` was still accepted; it is
  not.** The `/1` window closed with #294 and both `validateManifest` (load) and `checkManifest`
  (conformance) reject it, but the header comment, the conformance file's first line and the
  `ModuleApi` union all still described a transitional acceptance nine lines above the Set that
  refuses it. `ModuleManifest.api` and `ModulesResponse.api` are now typed `SupportedModuleApi`
  (`vivijure-module/2`), `ModuleApi` is documented as the historical epoch names rather than as
  policy, and `SUPPORTED_MODULE_APIS` is built from `MODULE_API` so the two cannot drift. Two test
  fixtures that declared `api: "vivijure-module/1"` -- an epoch the loader refuses -- were corrected
  to `/2`.
