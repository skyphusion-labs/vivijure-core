### Feat: the caller picks the dialogue module (vivijure-core#339)

`dialogue` is pick_one, but five sites in the film orchestrator took `servingForHook(modules, "dialogue")[0]` and sent `config: {}`. So the module that ran was the first by ui.order, whatever the caller chose, and it never got the caller's config. The studio offers two dialogue modules (`dialogue-gen` and `chatterbox`), so the voice a user picked was not the voice that ran.

- New `pickDialogueModule` (`src/modules/dialogue-select.ts`) is the one place a dialogue module is chosen. All five sites and both start paths use it, and `tests/dialogue-select-339.test.ts` fails on any other lookup in `src/`.
- The render overrides bag takes `dialogue_backend` (as `keyframe_backend` and `motion_backend`). `resolveModuleRenderConfigs` returns it, plus `dialogue_config`: the caller's config for each dialogue module it sent config for, clamped to that module's schema. `startFilmJob` and `startFilmFromKeyframes` take both and persist them on `FilmJob`, so every dialogue tick resolves the same module. Scatter passes them to every shard.
- A name that does not serve `dialogue` is refused by name: at start, before anything is spent, and at any dialogue site if the module goes away mid-film. It is never replaced with the default, and on the post-clip leg it fails the film rather than shipping it silent.
- Both are in the submit idempotency key, so two films that differ only in dialogue module are two films.
- **No selection keeps the old behaviour:** the first serving module by ui.order, sent `{}`.

**For a host.** Pass `dialogue_backend` and `dialogue_config` from `resolveModuleRenderConfigs` into `startFilmJob` / `startFilmFromKeyframes`, as you pass `keyframe_backend` and the other configs today. A host that does not pass them gets the old behaviour. The idempotency fingerprint gains two fields, so a submit in flight across the upgrade is not deduplicated against one from before it.
