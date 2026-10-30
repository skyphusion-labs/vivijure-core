### fix(keyframe): a split film no longer trains one LoRA per job

A keyframe module that declares `trains_loras` gets one job when any storyboard slot has no adapter, or when the slots cannot be read. With every adapter present, the film splits as before. A module that does not declare it is unchanged.
