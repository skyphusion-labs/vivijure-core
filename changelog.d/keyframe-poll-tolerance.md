### fix(film): a keyframe poll tolerates a passing failure, as a clip poll does

A keyframe poll that failed in transport, such as `module /poll -> 500`, ended the film at once. It now waits, for up to 3 consecutive ticks, then fails by name and stops the keyframe jobs. A tick with no such failure resets the count. A failure the module reports still fails at once. A sibling's finished output is kept while it waits.
