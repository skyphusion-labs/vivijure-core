### fix(film): a driving-audio door with zero lined shots still gets silence (core#342)

`wantsPreClipDialogue` required `driving_audio === true` and at least one lined shot. A door that cannot render without audio then skipped the phase, left `dialogue_audio` empty, and failed every shot. The gate is now the driving-audio declaration alone. An empty lined set does not call the dialogue provider; `finalizePreClipDialogue` mints silence for each unlined shot.
