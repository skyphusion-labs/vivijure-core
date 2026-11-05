**Feat: a storyboard can name the film's place once, in an optional `setting`.**

`setting` is one short place phrase ("a dim workshop at night"), at most 100 characters and one line. The validator keeps it trimmed and leaves it out when absent or blank, and `serializeStoryboardYaml` writes `setting:` only when it is set, so a board without it validates and serializes byte for byte as before. The planner is asked to fill it, its worked example does, and a refine keeps it. The renderers add it to any shot whose own prompt does not already name it (vivijure-cf#1145).
