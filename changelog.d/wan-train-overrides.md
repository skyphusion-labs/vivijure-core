### feat(train): pass train_overrides to wan-train

The worker allow-list (batch_size, resolution, steps) was live and
unreachable. POST /api/cast/:id/train-wan-lora now accepts
train_overrides / trainOverrides; unknown keys are dropped so a typo
cannot fail a train. SDXL /train-lora does not emit the field.
