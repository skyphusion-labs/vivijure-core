### feat(cast-train): hosted Wan-train jobs carry the tenant R2 block

A pooled Wan-train endpoint cannot write every tenant into the
template bucket. `buildTrainWanLoraPayload` accepts optional `r2`
(endpoint, access_key_id, secret_access_key, bucket) and puts it
on `input.r2`. `submitTrainWanLoraJob` attaches `tenantR2FromEnv`.
Operator studio without the R2_S3_* env omits the block; hosted
studio has those vars so the block is present. Absent, never null.
