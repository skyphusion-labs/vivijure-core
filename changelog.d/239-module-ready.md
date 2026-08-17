### feat(ready): shared /ready type and classifier

The module `/ready` envelope lived as prose in cf (emit) and
control-plane (classify). `src/module-ready.ts` is the shared type
plus `classifyReadyResponse`. Pair test covers RunPod-endpoint,
door-backed, public-slug, blender-without-door, 404, and echo
mismatch. Not published this cut; plane keeps its local copy until
the next core release.
