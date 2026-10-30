### fix(film-finish): a vertical film keeps the assembled frame

`film.finish` seeded 1920x1080 whenever the job had no `delivery_width`. Assemble already used the measured clip geometry, so a 720x1280 film was pillarboxed and its title card drawn in a landscape frame. The seed now uses the frame assemble built. An operator `delivery_width` and `delivery_height` still win. Card and caption sizes are set in the video-finish container and do not change here, and neither does the per-shot finish target.
