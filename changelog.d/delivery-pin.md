### fix(film): a film start keeps the frame it was asked for

`startFilmJob` took `delivery_width` and `delivery_height` and dropped them, so the frame came from the measured clips. Parts on different doors could differ, and the join refuses that. A film at InfiniteTalk's shape now goes out at 1920x1080 with bars of 4 and 6 px, where it was 1936x1080. A shot is noted when its clip shrinks by more than 2% to fit, or fills under 90% of the frame. The frame rate is still not pinned.
