### fix(film): a new still does not buy the shot before it

A door that does not declare `usage.first_last` no longer gets an end frame, so none is in its clip's proof. For a door that does, `startFilmFromKeyframes` takes `held_end_frames`: the named shot keeps its old end frame, so its proof holds. A clip already stamped with an end frame on a door that ignores it is bought once more on its next retry.
