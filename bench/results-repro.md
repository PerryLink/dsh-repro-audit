# dsh-repro-audit benchmark: repro

- Dataset: `repro` v0.1.0 (10 synthetic recipe cases)
- Plugin: `dsh-repro-audit` v0.1.2
- Call: `ReproAuditRuntime.manifest({ path: "project" })` then `ReproAuditRuntime.check({ manifest, path: "project" })`
- Command: `pnpm run bench:repro`
- Fixtures: one fresh `mkdtemp` per case; git identity `fixture@example.invalid`; drift applied after the manifest
- Cases passed: **10/10 (100.00%)**

## Metrics

| Metric | Result |
|---|---|
| Level accuracy (manifest, record time) | 10/10 (100.00%) |
| Gap precision (micro) | 7 TP / 0 FP = 1.000 |
| Gap recall (micro) | 7 TP / 0 FN = 1.000 |
| Gap F1 | 1.000 |
| Exact gap set | 10/10 (100.00%) |
| Drift detection | 3/3 (100.00%) |
| Exact drift finding | 3/3 (100.00%) |
| No false positives | 7/7 (100.00%) |
| Cases passed | 10/10 (100.00%) |

`expected.gaps` is an exact hand-authored code set, not a superset tolerance. Level accuracy compares the
manifest level at record time; the drift score is separate. `modify` appends one LF to the recorded file
after the manifest; `delete` removes it.

## Distribution

| Category | Cases |
|---|---:|
| `complete` | 1 |
| `evidence-gap` | 2 |
| `runtime-gap` | 2 |
| `git-gap` | 2 |
| `drift` | 3 |

| git mode | Cases |
|---|---:|
| `none` | 1 |
| `commit` | 7 |
| `dirty` | 1 |
| `commit-then-modify` | 1 |

| drift | Cases |
|---|---:|
| `none` | 7 |
| `modify` | 2 |
| `delete` | 1 |

| expected level | Cases |
|---|---:|
| `reproducible` | 4 |
| `partial` | 3 |
| `not_reproducible` | 3 |

## Cases

| Case | Category | git | drift | Expected level | Actual level | Expected gaps | Actual gaps | Gap set | Drift | Pass |
|---|---|---|---|---|---|---|---|---|---|:---:|
| `repro-0001` | complete | commit | none | reproducible | reproducible | — | — | exact | clean | yes |
| `repro-0002` | evidence-gap | commit-then-modify | none | partial | partial | dirty_worktree, no_seed | dirty_worktree, no_seed | exact | clean | yes |
| `repro-0003` | evidence-gap | commit | none | not_reproducible | not_reproducible | no_lockfile | no_lockfile | exact | clean | yes |
| `repro-0004` | git-gap | none | none | not_reproducible | not_reproducible | no_git_commit | no_git_commit | exact | clean | yes |
| `repro-0005` | git-gap | dirty | none | partial | partial | dirty_worktree | dirty_worktree | exact | clean | yes |
| `repro-0006` | runtime-gap | commit | none | not_reproducible | not_reproducible | no_run_command | no_run_command | exact | clean | yes |
| `repro-0007` | runtime-gap | commit | none | partial | partial | no_environment | no_environment | exact | clean | yes |
| `repro-0008` | drift | commit | modify:data/input.csv | reproducible | reproducible | — | — | exact | exact: changed data/input.csv | yes |
| `repro-0009` | drift | commit | delete:data/input.csv | reproducible | reproducible | — | — | exact | exact: missing data/input.csv | yes |
| `repro-0010` | drift | commit | modify:package-lock.json | reproducible | reproducible | — | — | exact | exact: changed package-lock.json | yes |
