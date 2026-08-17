### feat(conformance): require max_invocation_seconds on finish/speech

`checkManifest` now fails a module serving `finish` or `speech` that
omits `max_invocation_seconds`. Load stays permissive: `validateManifest`
still accepts an absent value so a third-party module is not our gate
to fail. Notify and other non-ceiling-derived hooks stay silent. Not a
warning and not an override.
