### fix(assemble-admission): do not admit a film larger than one upload carries

`assembleFilmByteCeiling` is now the lower of the disk budget and `R2_SINGLE_PUT_BYTES`, 5,363,466,240 bytes. The disk budget alone allowed 6.85 GB, and the container writes each film with one PUT, so a film between the two did all its work and then failed at upload. At 1920x1080 and 24 fps the predicted limit falls from about 82 minutes to about 64.
