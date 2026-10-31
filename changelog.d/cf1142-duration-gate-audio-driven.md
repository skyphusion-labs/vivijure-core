**Fix: the duration gate reads the line length on an audio-driven door (vivijure-cf#1142).**

A door with `usage.driving_audio` makes a clip as long as its line, so a short line on a longer planned shot failed the finished film after every clip was paid for. Such a shot is now gated against the line's length. A truncated clip still fails, and every other door is unchanged.
