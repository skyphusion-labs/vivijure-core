### docs(core): correct core's speech-upscale references; the speech hook, phases and transport stay

`speech-upscale` was a vivijure-cf MODULE; `speech` is a vivijure-core HOOK. Conrad
ruled the module out (cf#786): its RunPod endpoint no longer exists, its only planner
trigger was the `finish-lipsync` checkbox removed in cf#785, its purpose (cleaning
dialogue before POST-HOC mouth replacement) retired when lip-sync moved to motion time
via `infinitetalk` taking Cast audio directly, and it is CUDA, a stage the finishing
tier cannot host (fc#2234).

Measured in cf's manifests rather than assumed: `speech-upscale` declares
`hooks: ["speech"]` and is the only module under `vivijure-cf/modules/` whose source
mentions speech (`audio-master` declares `master`). So once cf's PR lands the `speech`
hook has ZERO shipped implementations. Following #293, the mechanism stays and the docs
SAY so: `docs/CORE-VS-MODULES.md` now states there is no shipped implementation, and its
example binding row is the hook-generic `MODULE_SPEECH`, since core branches on hook
names and never on module names.

Comments that named the deleted module as a live counterpart are corrected.
`speechEnhancedAudioKey` is no longer described as a mirror of a module helper: with no
shipped module it is the only live statement of the `_enh.wav` convention, and
`SpeechInput.output_key` is the side a future speech module matches.
`tests/finish-presign-312.test.ts` was one half of a cross-repo transcription lock whose
other half is gone, so its header now says which gate survives --
`finish-presign-keyset-312.test.ts`, which drives `attachFinishPresigns` /
`attachSpeechPresigns` at the one injected seam (`env.PRESIGNER`) and asserts the key
set -- so a pure-helper suite is not mistaken for transport coverage.

No behaviour change and no exported symbol removed. `speechEnhancedAudioKey` stays:
`attachSpeechPresigns` calls it and `src/index.ts` re-exports `film-orchestrator.js`, so
removing it would break the published surface for a contract that is still live. The
`speech` / `pre_clip_speech` phases, `advanceSpeechPhase`, the chain resolution and the
presign path are untouched, as is `infinitetalk`. Test fixtures naming `speech-upscale`
or `MODULE_SPEECH_UPSCALE` stay: their subjects are generic speech-chain, phase-ceiling,
progress-marker, pre-clip-dialogue and ready-classifier logic, and renaming a fixture
deletes coverage history while proving nothing. `vivijure-local` is deliberately skipped
(on hold), so that divergence is a decision, not an oversight.
