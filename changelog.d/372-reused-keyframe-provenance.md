### fix(keyframe): a reused still keeps its own provenance

A module may mark a returned still `reused: true`. The core no longer stamps its config hash on it, because that claimed a config match the still did not have.
