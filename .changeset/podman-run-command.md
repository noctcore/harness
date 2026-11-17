---
'@noctcore/harness': patch
---

Run the pinned image through the configured container CLI. `nodeRunDeps({ docker })` named another CLI (such as `podman`) only for the daemon check, the image lookup and the pull, while `runLinter` and `runGitleaks` still spawned `docker`. The run now uses it too, `nodeGitleaksDeps` accepts the same `docker` option, and hand-built deps can set `dockerCommand`.
