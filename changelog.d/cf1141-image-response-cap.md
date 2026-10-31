**Fix: the module response cap fits an image on the image.generate hook (vivijure-cf#1141).**

That hook carries the picture in its response, so a detailed image over about 786 KB failed after the provider was paid. The cap for that hook is now 32 MB. Every other hook stays at 1 MB.
