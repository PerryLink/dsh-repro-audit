# dsh-repro-audit

**别人能不能复现这个分析 —— 以及从你记录到现在，有没有东西变了？**

*有界、只读的扫描：记录 commit、lockfile、环境、数据哈希、图表、seed 与运行命令；对这份记录做漂移检查；生成可直接交给评审的报告卡。*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

[English](README.md) · 简体中文

---

## 它做什么

- **`repro_manifest`** scans a workspace project and records: git commit + dirty state, dependency lockfiles, environment pins (`.nvmrc`, `.python-version`, `pyproject.toml`, Dockerfile…), input-data hashes, figure hashes, notebooks, explicit random seeds (`random_state`, `np.random.seed`, `set.seed`, `torch.manual_seed`…) and runnable commands (package.json scripts, Makefile targets, `run`/`reproduce`/`analysis` entry scripts).
- **`repro_check`** re-scans and compares: an artifact that **changed** or **disappeared** is a finding — so a data file edited after the manifest is caught.
- **`repro_card`** renders the evidence as Markdown + SARIF 2.1.0, with every gap, its severity and a concrete suggestion.

Levels: `reproducible` (no error/warning gap), `partial` (warnings only), `not_reproducible` (any error gap or drift), `unknown` (reserved).

## 它做什么 not do

- **No execution.** Project code is never run; the only subprocesses are `git rev-parse` and `git status`, with a timeout and no shell.
- **No upload, no build.** It does not fetch data, install dependencies, or reproduce figures.
- **No truth claim.** A manifest proves these bytes existed; it does not prove the analysis is correct or complete.
- **No UI.** JSON + Markdown + SARIF only.

## 缺口代码

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

## 工具

### `repro_manifest`

`{ path? }` → `{ ok, manifest, recordPath }`. The record is a valid REP `ResearchRecord` whose `artifacts` are the code/env/data/seed/command/figure/notebook evidence.

### `repro_check`

`{ manifest | manifestPath, path? }` → `{ ok, drift }`. `manifestPath` is workspace-relative; `path` is the project to re-scan (defaults to the manifest's directory).

### `repro_card`

`{ manifest, drift? }` → `{ ok, markdown, sarif }`.

### Error codes

`INVALID_INPUT` · `NOT_FOUND` · `PATH_ESCAPE` · `NOT_A_DIRECTORY` · `INVALID_MANIFEST` · `STORE_ERROR`

## 兼容性与安装

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

## 配置

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` mounts nothing |
| `root` | `.repro-audit` | manifest + record root |
| `workspaceRoot` | `process.cwd()` | project paths must resolve inside it |
| `maxFiles` | `2000` | files visited per scan (over-limit reported) |
| `maxDepth` | `6` | directory depth |
| `maxFileBytes` | `8388608` | per-file hash cap (larger data is recorded unhashed + gap) |

Ignored directories: `.git`, `node_modules`, `.venv`, `dist`, `build`, `target`, `__pycache__`, `coverage`, `.next`, caches.

## 安全边界

- Read-only: no file is written inside the project; records go under `root`.
- Symlinks inside the project are reported and skipped, never followed.
- Hash caps prevent memory blow-ups; the file cap is reported, not ignored.
- `git` runs with fixed read-only arguments, a 5 s timeout and `windowsHide`; no shell.

## 评测

**17 tests**: scanning (lockfiles/data/figures/seeds/commands/runtimes, `node_modules` skipped, file cap), manifest levels (clean → reproducible, no seed → partial, no git → not_reproducible, dirty → partial, empty project gap set), drift (changed data + missing figure, clean re-check), runtime (valid REP record, inline manifest, saved manifest with project path, path escape), tools (schemas, manifest→check→card end-to-end, failure branch), package contract.

Manual sample matrix (no benchmark claimed — the artifact set is rule-based, not learned):

| Scenario | Expected | Covered |
|---|---|---|
| complete project, clean tree | `reproducible`, 0 gaps | test |
| no seed | `partial`, `no_seed` | test |
| no git | `not_reproducible`, `no_git_commit` | test |
| uncommitted change | `partial`, `dirty_worktree` | test |
| data edited after manifest | drift `changed`, `not_reproducible` | test |
| figure deleted | drift `missing` | test |
| just-recorded manifest | drift empty | test |

## 已知限制（v0.1）

- Metadata-level only: it does not verify that the recorded command actually reproduces the figures.
- Seeds are found by literal patterns; seeds injected via config files or environment variables are missed.
- Figures are hashed but not linked to the script that produced them (no provenance graph yet).
- Large data files are recorded unhashed (with a gap) rather than streamed.
- No `.gitignore` awareness: ignored-but-present files are still hashed if they are data/figure/extensions.

## 许可

Apache-2.0. No third-party runtime code.
