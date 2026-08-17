### fix(registry): thread preModules through remaining discover sites

Five orchestrator sites still called `discoverModules()` instead of
taking a request-scoped registry. Request-entry still discovers once
(`startScatterRender`, `advanceScatterJob`, `cancelFilmJob`) and
threads the result down. Callers below that boundary take `preModules`
and discover only if it is absent. A grep test pins the allowlist.
