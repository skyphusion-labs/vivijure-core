### fix(finish): a film that cannot deliver does not reopen on a retry (#384)

`retryFilmFinish` no longer reopens a film holding a refused shot, or a failed shot with no named step. Those shots would fail the finish phase again, after the other shots' steps had called their doors and spent money. `retried` is empty and no door is called. The event `film.finish_retry_blocked` names the shots.
