### Fix: beat analysis signs only a key in served artifact space

`analyzeAudioBeats` presigns the audio key before the beat-sync read. The key must be in served artifact space, the same prefixes the studio serve routes allow. A key outside that space, including one under `quarantine/`, is refused before any URL is signed. The refusal is permanent.
