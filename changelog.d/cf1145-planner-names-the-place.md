**Fix: the planner names the place in every shot (vivijure-cf#1145).**

A keyframe is drawn from its own shot prompt, and `full_prompt` does not reach it, so a planned shot with no place landed somewhere the model invented. The planner prompt now requires a place in every scene, and its example shows it.
