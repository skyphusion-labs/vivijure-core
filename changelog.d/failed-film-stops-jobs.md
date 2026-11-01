### fix(film): a film that fails stops its GPU jobs

A failed film left its jobs running, and paying. It now asks them to stop once, for keyframe, clip and finish jobs, as a user cancel does. This covers a throw in a tick and every other way a film fails in `advanceFilmJob`. A module that cannot cancel logs that its job runs on. A finish retry is left alone.
