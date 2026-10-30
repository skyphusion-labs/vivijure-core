**Feat: a finish retry says why it started nothing (vivijure-cf#1114).**

`retryFilmFinish` now returns `not_started` when `retried` is empty: `busy` when the film is advancing or still running, `nothing_to_retry`, or `cannot_deliver`. A caller can tell "try again" from "there is no point". Additive.
