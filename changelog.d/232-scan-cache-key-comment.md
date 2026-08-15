### docs(modules): the scan-cache key comment claimed a guarantee the key does not give (core#232)

The service-scan cache is keyed on the binding NAME SET. The comment said a cache taken against
another env can never answer the question, which is false whenever two envs bind the SAME names to
DIFFERENT modules. What makes it safe in production is the deployment model, not the key: a Worker
isolate serves one env whose service bindings are fixed at deploy time, and a redeploy is a new
isolate. Comment corrected to state that guarantee exactly, to name where the premise breaks (any
context evaluating two envs in one isolate, e.g. a vitest file), and to point at the existing reset
hook. No behaviour change.
