### Fix: the notify hook table names `render.failed`, and a scatter render whose mux door is not configured says it failed (vivijure-core#357)

#348 widened the `notify` contract to `render.failed`, but the hook table still said "render-complete notification" at `HookName` and in `HOOK_BLURBS`. A module author reads those lines first. Both now name both events.

On the scatter door, `fireNotifyForScatter` returned early with no `film_key` and always sent `render.complete`. The scatter mux leg for an unconfigured video-finish door fails the render and leaves `film_key` unset, so a scatter render that paid for every shard ended with no notice at all. That leg now sends `render.failed` and links the retained silent cut without making it `film_key`, the same shape the film path's `degradeMuxUnavailable` uses. `fireNotifyForScatter` takes the same `{ event, key }` options as the film path's `fireNotify`.

**For a host.** The `GET /api/modules` blurb for `notify` changes text. A notify module can now get `render.failed` from a scatter render, which a module that handles only `render.complete` must not announce as a finished film; the contract already says so.
