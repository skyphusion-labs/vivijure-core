# AGENTS.md

## Cursor Cloud specific instructions

Standard scripts are in `package.json`. Non-obvious VM gotchas:

- **Run the JS toolchain under Node 24.** The VM's default `node` is a wrapper
  (`/exec-daemon/node`, v22.14) that shadows nvm. This package sets `engines.node
  >=22.5.0`, but sibling repos run `.ts` files under bare `node` and Node < 22.18
  cannot type-strip them, so keep the whole workspace on Node 24 for consistency.
  Node 24 is installed via nvm by the environment update script; put it first on
  PATH: `export PATH="$HOME/.nvm/versions/node/v24"*"/bin:$PATH"`.
- **Install deps with the default Node 22 `npm` (v10), not Node 24's `npm` (v11).**
  npm 11 blocks the `esbuild` postinstall (a native binary vitest needs) behind an
  interactive allow-scripts prompt. Run `npm ci` on the default PATH (npm 10 runs
  the postinstall), then run typecheck/test/build under Node 24.

Verified in this environment (Node 24): `npm ci`, `npm run typecheck`,
`npm test` (269 passed), `npm run build` all pass.
