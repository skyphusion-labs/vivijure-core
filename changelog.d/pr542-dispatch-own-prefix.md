**Fix: dispatch discovery honours the studio's own module prefix.**

A host that sets `TENANT_MODULE_PREFIX` (the provisioning plane does, per studio) now dispatches only to `installed_modules` rows whose `script_name` is under it. Any other row is skipped with a warning. This is the core side of the studio install check (vivijure-cf#1412), so a row written by any other path still never reaches another studio's script. Unset, as on self-host, every row is dispatched as before.
