**Fix: a paid upscale now reaches the film, or the finish summary says it did not (#389).**

Assemble measured clip sizes from before finish, so a clip upscaled to 2688x1536 was scaled back to a 1344x768 film. It now measures finished clips, and `film.finish` reads the same frame, so a vertical film stays vertical. If an operator target is smaller than the clip, or a finished clip cannot be measured, the shot's `degraded` names it.

A per-shot finish step now aims at a 1080 short side at the clip's own shape, so a vertical clip aims at 1080x1920. A module may declare `finish_scales_frame`: the core prices the film at the frame that step will produce, and if it could not be assembled the step is refused by name before it spends, with code `assemble_budget`. The shot keeps its clip and the film still finishes.
