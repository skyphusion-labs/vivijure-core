#!/usr/bin/env bash
#
# Documentation address check.
#
# Docs and examples use the RFC 5737 documentation ranges rather than real internal
# VLAN addresses. postern adopted this convention in June 2026; a one-time cleanup with
# no check regresses quietly, so this runs on every PR.
#
# SCOPE, and why it is narrow. This matches the 10.1.x.y VLAN space only. It deliberately
# does NOT match the RFC 1918 addresses used as SSRF / URL-guard test vectors (10.0.0.5,
# 192.168.1.1, 172.16.0.10). Those vectors assert that private addresses are BLOCKED; a
# check that forced them to be scrubbed would make the codebase worse and would be turned
# off by the first person it annoyed.
#
# NO SELF-EXCLUSION, NO IN-CONTENT HATCH. The pattern below is written escaped, so this
# file does not match itself and needs no exemption of its own. There is deliberately no
# marker a file can carry to opt out (a marker in the content is a hatch that disarms
# itself). The only exemption is ALLOWLIST, set in .github/workflows/doc-addresses.yml,
# which means every exemption shows up in that file's diff and gets reviewed.
#
# Usage: bash scripts/check-doc-addresses.sh   (ALLOWLIST optional, one pathspec per line)

set -euo pipefail

PATTERN='\b10\.1\.[0-9]{1,3}\.[0-9]{1,3}\b'

allow=()
while IFS= read -r line; do
  [ -n "${line// }" ] && allow+=(":(exclude)${line}")
done <<< "${ALLOWLIST:-}"

hits=$(git grep -nIE "$PATTERN" -- . ${allow[@]+"${allow[@]}"} || true)

if [ -z "$hits" ]; then
  echo "OK: no internal VLAN addresses in tracked files."
  exit 0
fi

echo "FAIL: internal VLAN address found in tracked files (file:line below)."
echo
printf "%s\n" "$hits" | sed "s/^/  /"
echo
cat <<'REMEDY'
Remedy: use an RFC 5737 documentation range instead, and keep the instruction
followable:

  192.0.2.0/24    198.51.100.0/24    203.0.113.0/24

These are operator instructions, so prefer a named placeholder plus a one-line note
that the operator substitutes their own address (or refer to the variable itself, e.g.
$EDGE_BIND_IP) over a bare fake address that reads like a real setting to copy.

If a path genuinely needs an exception, add the pathspec to ALLOWLIST in
.github/workflows/doc-addresses.yml. There is no in-file marker on purpose: an
exemption belongs in a reviewed diff, not in the content it exempts.
REMEDY
exit 1
