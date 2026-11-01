### fix(film): a throw from startFilmJob says whether work is out

A throw before any module is invoked is now `FilmNotStartedError`, so a caller knows a retry is safe. After the invoke, the job write gets three tries. If it still fails, the keyframe job is cancelled, and the throw says so, instead of leaving a job nothing can find.
