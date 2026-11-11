### Fix: the consumer suite removes its pack directory on every run (#526)

`scripts/consumer-suite.mjs` packed the build into a `core-consumer-pack-*` directory in `$TMPDIR` and never removed it. On a laptop, where `$TMPDIR` is not cleared at boot, every run left one more tarball. The directory is now removed on every path out of the run, including each early return. A new test runs a PASS and a FAIL case, each with its own `TMPDIR`, and asserts no `core-consumer-pack-*` directory survives.
