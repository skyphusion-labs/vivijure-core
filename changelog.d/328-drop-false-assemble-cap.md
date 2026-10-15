### fix(film): drop the false assemble-attempt cap (core#328)

Comments said re-concat stops after a max attempt count. There is no such cap. The counters were never read. The claims and the fields are gone. Re-concat is unchanged.
