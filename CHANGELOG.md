# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `repro_check` resolves a saved manifest through `realpath` and rejects a
  symlink that escapes the workspace (`PATH_ESCAPE`).
- Malformed saved manifests (invalid JSON, `null`, or missing required arrays)
  return `INVALID_MANIFEST` instead of throwing a `SyntaxError`/`TypeError`.
- `repro_card` validates its manifest/drift inputs (including `null` and each
  drift finding's expected/actual fields) and returns `INVALID_MANIFEST`/
  `INVALID_INPUT` rather than crashing on malformed JSON.
- The symlink-skipping test now creates a real symlink and asserts that it is
  skipped (the previous assertion was unconditional `|| true`).
- `package.json`, `jsconfig.json` and `tsconfig*.json` are no longer classified
  as input data; a Node project therefore no longer suppresses the `no_data`
  gap with its build configuration.
- The `no_seed` gap now recognizes lowercase `.r` (and `.Rmd`/`.qmd`) scripts;
  it previously matched only `.py` and uppercase `.R`.
- Exclude the configured record store from the scan when it is inside the
  project (the default `.repro-audit/` is also in the skip list); previously a
  second manifest/drift check hashed its own records as added data.
- Disable repository-local fsmonitor hooks for the read-only `git` calls: a
  repository can configure `core.fsmonitor` to an executable, which `git status`
  would run. `GIT_OPTIONAL_LOCKS=0` also keeps `git status` from refreshing the
  index. A regression test asserts the hook is not executed.

### Changed

- Test count is now 23; the README and evaluation notes list the new failure
  branches.

## [0.1.0] - 2026-11-08

First release: reproducibility evidence and drift detection.

### Added

- `repro_manifest`: bounded, read-only scan recording git commit/dirty state,
  lockfiles, environment pins, data/figure/notebook hashes, seed literals and
  runnable commands, plus gap severities and a reproducibility level.
- `repro_check`: re-scan and compare — changed, missing and added artifacts —
  with the level downgraded when recorded evidence no longer matches.
- `repro_card`: Markdown report card + SARIF 2.1.0.
- REP v1 integration: the manifest's artifacts are written as a valid
  `ResearchRecord` with `Artifact` rows (code/env/data/seed/command/figure/
  notebook) and the manifest itself alongside it.
- Path containment, symlink skipping, file/depth/hash caps; `git` only via
  fixed read-only arguments with a timeout.
- 17 tests; manual scenario matrix in the README.

### Notes

- Metadata-level audit only: a manifest proves bytes existed, not that the
  analysis is correct or that its command reproduces the figures.
