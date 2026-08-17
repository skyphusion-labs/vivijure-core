### feat(ready): shared /ready type and classifier

The module GET /ready contract lived as prose in two repos. Core now
owns the wire type and `classifyReadyResponse` (cp#468 rules: ask the
module which credentials it needs; door-backed and public-slug must
not be required to show `runpod_endpoint_id`; 404 is unverifiable;
module-echo mismatch is misconfigured). Control-plane keeps its local
copy until a core release. Does not publish.
