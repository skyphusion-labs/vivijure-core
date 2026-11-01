### fix(film): a film failing at the keyframe ceiling stops its keyframe jobs

When a film fails at the phase ceiling with a partial keyframe set, the core now cancels the keyframe jobs still running before it marks the film failed.
