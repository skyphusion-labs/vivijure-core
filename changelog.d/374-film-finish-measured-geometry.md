### fix(film-finish): a vertical film keeps the assembled frame

`film.finish` and per-shot finish seeded 1920x1080 whenever the job had no `delivery_width`. Assemble already used the measured clip geometry, so a 720x1280 film was pillarboxed when the title card ran. Both finish paths now use that measured geometry. An operator delivery target still wins. The 1920x1080 default remains only when nothing was measured.
