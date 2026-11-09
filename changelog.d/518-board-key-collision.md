### Feat: a board is refused when another project already renders under its title key (vivijure-core#518)

The backend keys every stored artifact of a render by the board title: `normalizeProjectName(title)` builds `bundles/<key>-<hex>.tar.gz`, the studio remaps the render's `project` to `<key>`, and the backend writes and later reads back `renders/<key>/...` and `loras/<key>/...`. Two projects whose titles share a key reused each other's keyframes and LoRAs as their own (vivijure-backend#487).

- `setLastStoryboard` now throws `BoardKeyCollisionError` before it writes, when another project in the tenant holds the board's key. The error names the holder (`existing: { id, name, title }`, the public id) and the key (`slug`). Saving a project's own board again, or retitling it, is never refused by itself. An untitled board is not checked.
- The key is core's rule, not the backend's `_slug`. `Two O'Clock` and `Two O_Clock` collide here, because core maps both to `Two_O_Clock`.
- New exports: `boardKeySlug`, `findBoardKeyHolder`, `BoardKeyCollisionError`, `BoardKeyHolder`.
- `tests/project-key-contract-487.test.ts` pins core's rule by golden table, pins a copy of the backend golden (with its source sha), and asserts the backend `_slug` returns every core key unchanged.

**For a host.** Map `BoardKeyCollisionError` to `409` with its message on every route that saves a board (PATCH project with `storyboard`, save storyboard, a film that saves its board to a project). Until a host does, the refusal surfaces as a `500`. The check is not transactional: two concurrent first saves of one key can both pass.
