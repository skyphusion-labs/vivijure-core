### fix(finish): omit clip_key when presigns attach

`attachFinishPresigns` / `attachSpeechPresigns` minted GET/PUT URLs and
left `clip_key` / `audio_key` on the invoke body. Satellites select
R2 vs presigned on key presence, so the credentialless branch never
ran. After a complete all-or-nothing presign the keys are deleted;
a skip or a missing dialogue `audio_url` keeps them (R2 fallback).
