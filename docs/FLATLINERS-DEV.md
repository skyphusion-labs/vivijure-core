# HISTORICAL: flatliners dev box (RETIRED 2026-07-16)

> **Do not use.** The Hetzner cloud server `flatliners` (`150062483` / `178.105.200.248`) was
> deleted after the vivijure-local cutover to **propagandhi**. Laptop `Host flatliners` SSH is
> commented retired. GPU + studio ops live on propagandhi (`10.1.1.7`).
>
> Topology: fleet-chezmoi `system/stacks/propagandhi/RUNBOOK-vivijure-local-topology.md`.

The sections below are kept only so old links and chat transcripts still resolve. Commands that
`ssh flatliners` will fail.

---

# flatliners dev box (archived)

**Former host:** `flatliners` (`178.105.200.248`, `User conrad` in laptop `~/.ssh/config`).

Use **git from GitHub `main`**, not laptop rsync. `gh` is installed and authenticated as `skyphusion`.

## Layout (sibling clones)

```
~/dev/
  vivijure-core/    # this repo
  vivijure/         # contract upstream (parity + quality-tier manifest guard)
  vivijure-local/   # optional Node host
```

## Bootstrap (first time) -- archived

Prefer propagandhi / local laptop clones. Historical bootstrap:

```bash
mkdir -p ~/dev
cd ~/dev
gh repo clone skyphusion-labs/vivijure-core
gh repo clone skyphusion-labs/vivijure-cf
```

## Sync script

`scripts/flatliners-sync.sh` remains in-tree as a historical helper name. It is not an active
operator path. Do not schedule it.
