### feat(scatter): resolveShardCount -- omitted parallelism uses the worker pool, not 2

Hosts defaulted `shardCount` to 2, the minimum that still counts as a
scatter. That is a floor, not a capacity default. A 10-shot film on a
20-worker endpoint used 2 GPUs. `resolveShardCount` (omitted ->
`min(shots, defaultMax=20)`, explicit N clamped to `[1, shots]`) is the
shared rule. Hosts pass `RENDER_SHARD_MAX` when they have a different cap.
