### feat(film): retake one shot and keep the rest

`startFilmJob` and `startFilmFromKeyframes` take `retake_shots`. With `reuse_finished`, those shots buy a new clip even when the old one is proven. An unchanged line is kept. Finish follows the clip.
