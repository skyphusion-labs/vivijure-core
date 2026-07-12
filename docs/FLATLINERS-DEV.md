# flatliners dev box

**Host:** `flatliners` (`178.105.200.248`, `User conrad` in laptop `~/.ssh/config`).

Use **git from GitHub `main`**, not laptop rsync. `gh` is installed and authenticated as `skyphusion`.

## Layout (sibling clones)

```
~/dev/
  vivijure-core/    # this repo
  vivijure/         # contract upstream (parity + quality-tier manifest guard)
  vivijure-local/   # optional Node host
```

## Bootstrap (first time)

```bash
mkdir -p ~/dev
cd ~/dev

# One-time if SSH clone hits "Host key verification failed":
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts

gh repo clone skyphusion-labs/vivijure-core
gh repo clone skyphusion-labs/vivijure
# optional:
# gh repo clone skyphusion-labs/vivijure-local
```

## Sync to latest `main`

From laptop:

```bash
ssh flatliners 'bash -s' < scripts/flatliners-sync.sh
```

Or on flatliners:

```bash
cd ~/dev/vivijure-core && git fetch origin && git checkout main && git pull --ff-only origin main
cd ~/dev/vivijure      && git fetch origin && git checkout main && git pull --ff-only origin main
```

## Verify (core)

```bash
cd ~/dev/vivijure-core
npm ci
npm run typecheck
npm test
npm run parity:vivijure    # needs sibling ../vivijure on main
```

## Feature branch (before merge)

```bash
cd ~/dev/vivijure-core
git fetch origin
git checkout feat/your-branch
git pull --ff-only origin feat/your-branch
npm ci && npm run typecheck && npm test
```

Same pattern for `vivijure` if the branch touches the contract.

## Do not

- `rsync` laptop trees onto flatliners (stale, no `.git`, wrong workflow).
- Commit from flatliners unless you intend to; laptop is the default author surface for Conrad PRs.
