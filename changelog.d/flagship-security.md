### fix(security): fail closed media door bearer

A configured public media door (`VIDEO_FINISH_URL` and siblings) with an empty
`MEDIA_FINISH_TOKEN` no longer sends an unauthenticated request. `mediaFinishHeaders`
and `mediaDoorFetch` throw `MediaFinishAuthError`. Assemble treats that as a hard
fail. Self-host with no door URL stays off (fetch returns null).

### fix(security): confine module-returned keys to the project

`assertProjectKey(project, key)` requires a safe relative key under
`renders/<project>/`. Motion `clip_key`, finish `clip_key`, keyframe
`keyframe_key`, and `trained_loras` values are refused when they escape that
prefix. Bundle keys are not accepted on those outputs.

### fix(security): do not attach tenant R2 to dispatch modules

`needsTenantR2` / `withTenantR2` attach credentials only for a first-party
module (service-bound, locality `local` | `byo` | `cloud` or undeclared).
A WfP dispatch/community module that sets `needs_tenant_r2` still does not
receive the block.

### fix(motion): cap voice_lock and style_prefix at 500 chars

`composeMotionPrompt` and `buildVoiceLock` truncate each lock field to 500
characters so a long lock cannot blow the motion prompt.
