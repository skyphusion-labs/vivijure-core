**Fix: archived clip takes are bounded, and a render copies only what it replaces (#395).**

Every render copied every live clip for the shot, finish outputs included, and nothing pruned. It now copies the clip its own door is about to replace, or every door clip when no file matches that door's name, and never a finish output. It keeps the newest 3 takes per clip and deletes older ones, including the finish output copies older renders left. Storage is freed the next time that shot renders. A deleted take is gone, and nothing in the product reads one.
