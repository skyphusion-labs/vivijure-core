### fix(film): a film start keeps the frame it was asked for

`startFilmJob` took `delivery_width` and `delivery_height` and dropped them, so the frame came from the measured clips. Parts on different doors could differ, and the join refuses that. A film at InfiniteTalk's shape now goes out at 1920x1080 with about 4 px of bars at top and bottom, where it was 1936x1080. Each such shot also carries a note that its clip was larger than the film.
