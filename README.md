# dsh-repro-audit

**Would someone else be able to reproduce this analysis — and has anything drifted since you recorded it?**

*A bounded, read-only scan that records the commit, lockfiles, environment, data hashes, figures, seeds and run commands; a drift check against that record; and a report card you can hand to a reviewer.*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

English · [简体中文](README-zh.md)

---

## What it does

- **`repro_manifest`** scans a workspace project and records: git commit + dirty state, dependency lockfiles, environment pins (`.nvmrc`, `.python-version`, `pyproject.toml`, Dockerfile…), input-data hashes, figure hashes, notebooks, explicit random seeds (`random_state`, `np.random.seed`, `set.seed`, `torch.manual_seed`…) and runnable commands (package.json scripts, Makefile targets, `run`/`reproduce`/`analysis` entry scripts).
- **`repro_check`** re-scans and compares: an artifact that **changed** or **disappeared** is a finding — so a data file edited after the manifest is caught.
- **`repro_card`** renders the evidence as Markdown + SARIF 2.1.0, with every gap, its severity and a concrete suggestion.

Levels: `reproducible` (no error/warning gap), `partial` (warnings only), `not_reproducible` (any error gap or drift), `unknown` (reserved).

## What it does not do

- **No execution.** Project code is never run; the only subprocesses are `git rev-parse` and `git status`, with a timeout and no shell.
- **No upload, no build.** It does not fetch data, install dependencies, or reproduce figures.
- **No truth claim.** A manifest proves these bytes existed; it does not prove the analysis is correct or complete.
- **No UI.** JSON + Markdown + SARIF only.

## Gap codes

| Code | Severity | Meaning |
|---|---|---|
| `no_git_commit` | error | not a git repo, or no commit |
| `no_lockfile` | error | no dependency lockfile recorded |
| `no_run_command` | error | no entry point found |
| `dirty_worktree` | warning | uncommitted changes; the commit does not describe the files |
| `no_seed` | warning | scripts exist but no seed literal was found |
| `no_data` | warning | no input data file in the project |
| `no_environment` | warning | no runtime/environment pin |
| `unhashed_data` | warning | a data file exceeded the hash cap |
| `no_figures` | info | no figure/table output |
| `scan_truncated` | warning | the file cap was reached |

Error gaps make the level `not_reproducible`; warnings make it `partial`.

## Tools

### `repro_manifest`

`{ path? }` → `{ ok, manifest, recordPath }`. The record is a valid REP `ResearchRecord` whose `artifacts` are the code/env/data/seed/command/figure/notebook evidence.

### `repro_check`

`{ manifest | manifestPath, path? }` → `{ ok, drift }`. `manifestPath` is workspace-relative; `path` is the project to re-scan (defaults to the workspace root).

### `repro_card`

`{ manifest, drift? }` → `{ ok, markdown, sarif }`.

### Error codes

`INVALID_INPUT` · `NOT_FOUND` · `PATH_ESCAPE` · `NOT_A_DIRECTORY` · `INVALID_MANIFEST` · `STORE_ERROR`

## Compatibility & install

| | |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`** (verified 2026-11-08); peer `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0` (tested `24.22.1`), ESM only |
| Peers | `@perrylink/dsh-research-core ^0.1.0`, `@deepseek-ai/cordis ^4.0.5-alpha.1`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| Runtime dependencies | **zero** |

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-repro-audit
dsh --profile <name> --dump-config | grep dsh-repro-audit
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` mounts nothing |
| `root` | `.repro-audit` | manifest + record root |
| `workspaceRoot` | `process.cwd()` | project paths must resolve inside it |
| `maxFiles` | `2000` | files visited per scan (over-limit reported) |
| `maxDepth` | `6` | directory depth |
| `maxFileBytes` | `8388608` | per-file hash cap (larger data is recorded unhashed + gap) |

Ignored directories: `.git`, `node_modules`, `.venv`, `dist`, `build`, `target`, `__pycache__`, `coverage`, `.next`, caches, `.repro-audit`, plus the configured store root when it is inside the project.

## Security boundaries

- The project is read-only; records go under `root`. A store that lives inside
  the scanned tree (the default `.repro-audit/`) is excluded from the scan, so
  the manifest cannot include its own records.
- Symlinks inside the project are reported and skipped, never followed.
- Hash caps prevent memory blow-ups; the file cap is reported, not ignored.
- `git` runs with fixed read-only arguments, a 5 s timeout and `windowsHide`; no shell.
  Repository-local fsmonitor hooks are disabled (`-c core.fsmonitor=false`) and
  `GIT_OPTIONAL_LOCKS=0` keeps `git status` from refreshing/writing the index;
  inherited `GIT_*` variables are stripped so `git -C <root>` cannot be
  redirected to another repository.

## Evaluation

**27 tests**: scanning (lockfiles/data/figures/seeds/commands/runtimes, `node_modules` skipped, symlinks skipped but reported, project config not counted as data, lowercase `.r` scripts, file cap, own store excluded (including through symlinked/short workspace paths), fsmonitor hook not executed, inherited GIT_* ignored), manifest levels (clean → reproducible, no seed → partial, no git → not_reproducible, dirty → partial, empty project gap set), drift (changed data + missing figure, clean re-check), runtime (valid REP record, inline manifest, saved manifest with project path, malformed saved manifests rejected with `INVALID_MANIFEST`, symlinked manifest escape rejected, path escape), tools (schemas, manifest→check→card end-to-end, failure branch, malformed card input), package contract.

### Synthetic reproducibility benchmark

A separate **10-case, deterministic synthetic benchmark** (dataset `repro` v0.1.0) lives in the sibling `dsh-research-bench` repository under `data/repro`; it is not vendored into this package. Each case is a **recipe** — a relative-path→content file map, a git mode (`none`, `commit`, `dirty`, `commit-then-modify`) and a drift operation (`none`, `modify:<path>`, `delete:<path>`). The adapter materialises the recipe in a fresh `mkdtemp`, records a manifest with `ReproAuditRuntime.manifest`, applies the drift to the tree, then calls `ReproAuditRuntime.check`. Expected levels and gap-code sets are hand-authored from the recipe and the documented gap rules; the adapter never derives an expected value from plugin output.

Coverage: 1 complete clean project; 2 evidence gaps (missing seed, missing lockfile); 2 runtime gaps (no run command, no env pin); 2 git gaps (no repository, dirty worktree); 3 drift cases (recorded data modified, recorded data deleted, recorded lockfile modified). The missing-seed fixture also carries a tracked edit after the commit, so it exercises two warnings at once. All four git modes and all three drift modes are represented.

Measured with the commands below (Node 24.22.1, git 2.43.0):

| Metric | Result |
|---|---:|
| Level accuracy (manifest, record time) | 10/10 (100%) |
| Gap precision / recall (micro, exact code sets) | 1.000 / 1.000 |
| Exact gap-set match | 10/10 |
| Drift detection (findings non-empty) | 3/3 |
| Exact drift finding (status + path) | 3/3 |
| No false positives on clean cases | 7/7 |
| Cases passed | 10/10 |

```sh
pnpm run build
pnpm run bench:repro        # reads ../dsh-research-bench/data/repro (BENCH_DIR / --data override)
```

It writes `bench/results-repro.json` and `bench/results-repro.md` (no timestamps; re-running on the same dataset is byte-identical). Git is a hard prerequisite: the adapter exits with code 2 if `git` is not on `PATH`. Fixture repositories use the fixed identity `fixture@example.invalid`, an empty global git config and a temporary store outside the project, so host git settings and the recorded store cannot change the labels.

Unit-test sample matrix (the same scenarios are also covered by unit tests):

| Scenario | Expected | Covered |
|---|---|---|
| complete project, clean tree | `reproducible`, 0 gaps | test + benchmark |
| no seed | `partial`, `no_seed` | test + benchmark |
| no git | `not_reproducible`, `no_git_commit` | test + benchmark |
| uncommitted change | `partial`, `dirty_worktree` | test + benchmark |
| data edited after manifest | drift `changed`, `not_reproducible` | test + benchmark |
| figure deleted | drift `missing` | test |
| data deleted after manifest | drift `missing`, `not_reproducible` | benchmark |
| lockfile edited after manifest | drift `changed`, `not_reproducible` | benchmark |
| just-recorded manifest | drift empty | test + benchmark |

## Known limitations (v0.1)

- Metadata-level only: it does not verify that the recorded command actually reproduces the figures.
- Seeds are found by literal patterns; seeds injected via config files or environment variables are missed.
- Figures are hashed but not linked to the script that produced them (no provenance graph yet).
- Large data files are recorded unhashed (with a gap) rather than streamed.
- No `.gitignore` awareness: ignored-but-present files are still hashed if they are data/figure/extensions.
- The repro benchmark is synthetic and small (10 recipe cases): it measures scanner-level gap and drift rules, not real-world reproducibility. A 1.0 score is a regression baseline, not an unbiased estimate of accuracy on real repositories.
- The benchmark needs `git`; on a machine without it `bench:repro` exits with code 2 and writes no results.

## License

Apache-2.0. No third-party runtime code.
