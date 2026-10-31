**Feature: a film ships at the rate its finish chain produced (vivijure-cf#1144).**

A film with interpolation now delivers at the interpolated rate, for example 48 fps. A film with no interpolation stays at 24 fps. An explicit `delivery_fps` still wins, and the finish summary reports a clip above that rate. The assemble budget is now also asked at submit, at the predicted rate, so a film that cannot fit is refused before keyframes and clips are paid for.
