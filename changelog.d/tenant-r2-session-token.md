**Feat: the tenant R2 block can carry an optional session token, for temporary S3 credentials.**

When the studio env has `R2_S3_SESSION_TOKEN` next to the four R2 S3 values, `tenantR2FromEnv` adds it to the block as `session_token`. The four still decide whether a block exists. With no token, the block is unchanged.
