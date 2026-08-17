### feat(train): pass train_overrides to wan-train

`train_overrides` is live on the wan-train worker (batch_size,
resolution, steps) and was unreachable from every shipped caller.
`buildTrainWanLoraPayload` now emits the allow-list only; unknown keys
are dropped so a typo cannot fail a train. POST
`/api/cast/:id/train-wan-lora` accepts `train_overrides` /
`trainOverrides` and passes them through.

Refs skyphusion-labs/vivijure-wan-train#37.
