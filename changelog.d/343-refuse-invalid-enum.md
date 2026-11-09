### Feat: an enum value a module does not declare is refused by name, not replaced with the default (vivijure-core#343)

`validateConfig` turned an out-of-set enum value into the field default with no signal. Measured on the `infinitetalk` schema: `{"size":"1080p"}` became `{"size":"480p"}`, the same result as a caller who sent nothing. So any check below `validateConfig` against an invalid value was dead code, and a caller who sent a wrong value got the same success as one who sent none. Lead ruling on the issue: refuse, never silently default.

- `validateConfig` now throws the new `ConfigValueError` (`field`, `value`, `allowed`; message `config "<field>": <value> is not supported (allowed: ...)`) when a PRESENT enum value is not in `values`. `null` counts as present. An ABSENT value (missing key or `undefined`) still takes the default. Numbers, booleans and strings are unchanged.
- New `configValueRefusal(schema, user)`: the same sentence, or null, without throwing.
- New `filmStartConfigRefusal(modules, start)`: `startFilmJob` and `startFilmFromKeyframes` check the keyframe config and every motion config against the module it goes to, and fail the film by name before anything is spent, as an unknown dialogue module is refused (core#339).
- `resolveModuleRenderConfigs` and every other caller of `validateConfig` let the error propagate.

**For a host.** This is a MINOR because a previously accepted input is now refused. A client that relied on the silent default now gets an error naming the field. Map `ConfigValueError` to a 400 at every route that passes caller config into core (vivijure-cf#1383, vivijure-local#520); until a route does, it answers 500 where it used to answer 201. A stored `render_overrides` with a bad enum, accepted before this release, is refused when it is retried or finalized. A literal grep of vivijure-cf, vivijure-local and vivijure-mcp found no out-of-enum value that reaches `validateConfig` (method on the PR).
