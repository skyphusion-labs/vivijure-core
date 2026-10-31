**Fix: the finish summary says when interpolated frames do not reach the film (vivijure-cf#1144).**

`finish-rife` makes a 48 fps clip and the film ships at 24 fps, and nothing said so. A finished clip above the delivery rate now adds a `degraded` reason. The delivery rate itself is unchanged.
