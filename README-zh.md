# dsh-repro-audit

**别人能复现这项分析吗 —— 以及从你记录至今，有没有东西发生漂移？**

*有界、只读的扫描：记录 commit、lockfile、环境、数据哈希、图表、seed 与运行命令；对照这份记录做漂移检查；生成可直接交给评审的报告卡。*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

[English](README.md) · 简体中文

---

## 它做什么

- **`repro_manifest`** 扫描工作区中的一个项目并记录：git commit + 工作区脏状态、依赖 lockfile、环境版本固定（`.nvmrc`、`.python-version`、`pyproject.toml`、Dockerfile……）、输入数据哈希、图表哈希、notebook、显式随机种子（`random_state`、`np.random.seed`、`set.seed`、`torch.manual_seed`……）以及可运行命令（package.json scripts、Makefile targets、`run`/`reproduce`/`analysis` 入口脚本）。
- **`repro_check`** 重新扫描并对比：**发生变化**或**消失**的产物都会成为一项发现 —— 因此清单生成后被修改过的数据文件也能被抓住。
- **`repro_card`** 把证据渲染为 Markdown + SARIF 2.1.0，逐项列出缺口、严重级别和具体建议。

级别：`reproducible`（没有 error/warning 级缺口）、`partial`（只有 warning）、`not_reproducible`（存在任何 error 级缺口或漂移）、`unknown`（保留）。

## 它不做什么

- **不执行代码。** 绝不运行项目代码；唯一的子进程是 `git rev-parse` 和 `git status`，带超时且不经 shell。
- **不上传、不构建。** 它不抓取数据、不安装依赖，也不复现图表。
- **不声称结论为真。** 清单只能证明这些字节曾经存在，不能证明分析正确或完整。
- **没有 UI。** 只输出 JSON、Markdown 与 SARIF。

## 缺口代码

| 代码 | 严重级别 | 含义 |
|---|---|---|
| `no_git_commit` | error | 不是 git 仓库，或没有任何 commit |
| `no_lockfile` | error | 未记录依赖 lockfile |
| `no_run_command` | error | 未找到入口 |
| `dirty_worktree` | warning | 存在未提交的改动；commit 无法描述这些文件 |
| `no_seed` | warning | 存在脚本，但未找到 seed 字面量 |
| `no_data` | warning | 项目中无输入数据文件 |
| `no_environment` | warning | 未固定运行时/环境 |
| `unhashed_data` | warning | 某个数据文件超出哈希上限 |
| `no_figures` | info | 没有图表/表格产物 |
| `scan_truncated` | warning | 达到文件数上限 |

error 级缺口会把级别降为 `not_reproducible`；warning 会把级别降为 `partial`。

## 工具

### `repro_manifest`

`{ path? }` → `{ ok, manifest, recordPath }`。该记录是一条合法的 REP `ResearchRecord`，其 `artifacts` 是代码/环境/数据/seed/命令/图表/notebook 证据。

### `repro_check`

`{ manifest | manifestPath, path? }` → `{ ok, drift }`。`manifestPath` 相对于工作区；`path` 是要重新扫描的项目（默认是工作区根目录）。

### `repro_card`

`{ manifest, drift? }` → `{ ok, markdown, sarif }`。

### 错误码

`INVALID_INPUT` · `NOT_FOUND` · `PATH_ESCAPE` · `NOT_A_DIRECTORY` · `INVALID_MANIFEST` · `STORE_ERROR`

## 兼容性与安装

| | |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`**（2026-11-08 实测）；peer `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0`（实测 `24.22.1`），仅 ESM |
| Peer 依赖 | `@perrylink/dsh-research-core ^0.1.0`、`@deepseek-ai/cordis ^4.0.5-alpha.1`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| 运行时依赖 | **零** |

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-repro-audit
dsh --profile <name> --dump-config | grep dsh-repro-audit
```

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不挂载任何内容 |
| `root` | `.repro-audit` | 清单与记录的根目录 |
| `workspaceRoot` | `process.cwd()` | 项目路径必须解析到该目录内 |
| `maxFiles` | `2000` | 每次扫描访问的文件数（超限会报告） |
| `maxDepth` | `6` | 目录深度 |
| `maxFileBytes` | `8388608` | 单文件哈希上限（更大的数据只记录为未哈希 + 缺口） |

忽略的目录：`.git`、`node_modules`、`.venv`、`dist`、`build`、`target`、`__pycache__`、`coverage`、`.next`、各缓存目录、`.repro-audit`，以及配置的存储根目录（当其位于项目内时）。

## 安全边界

- 项目只读；记录写入 `root` 下。若存储目录位于被扫描的树内（默认的 `.repro-audit/`），该目录会被排除，因此清单不会把自己生成的记录也纳入。
- 项目内的符号链接会被报告并跳过，绝不跟随。
- 哈希上限用于防止内存暴涨；达到文件数上限时会报告，而不是静默忽略。
- `git` 以固定的只读参数运行，5 秒超时，并启用 `windowsHide`；不经 shell。仓库本地的 fsmonitor hook 被禁用（`-c core.fsmonitor=false`），`GIT_OPTIONAL_LOCKS=0` 阻止 `git status` 刷新/写入索引；继承来的 `GIT_*` 变量会被清除，因此 `git -C <root>` 无法被重定向到另一个仓库。

## 评测

**24 个测试**：扫描（lockfile/数据/图表/seed/命令/运行时、跳过 `node_modules`、符号链接跳过但报告、项目配置不计为数据、小写 `.r` 脚本、文件数上限、排除自身存储、不执行 fsmonitor hook、忽略继承的 `GIT_*`）、清单级别（干净 → reproducible、无 seed → partial、无 git → not_reproducible、有未提交改动 → partial、空项目的缺口集合）、漂移（数据变化 + 图表缺失、干净重查）、运行时（合法 REP 记录、内联清单、带项目路径的已保存清单、拒绝格式错误的已保存清单并报 `INVALID_MANIFEST`、拒绝符号链接清单逃逸、路径逃逸）、tools（schema、manifest→check→card 端到端、失败分支、格式错误的 card 输入）、包契约。

人工样例矩阵（不声称基准测试结果 —— 产物集合基于规则，而非学习得到）：

| 场景 | 预期 | 覆盖 |
|---|---|---|
| 完整项目、干净工作树 | `reproducible`，0 个缺口 | 测试 |
| 无 seed | `partial`，`no_seed` | 测试 |
| 无 git | `not_reproducible`，`no_git_commit` | 测试 |
| 有未提交改动 | `partial`，`dirty_worktree` | 测试 |
| 清单生成后数据被修改 | 漂移 `changed`，`not_reproducible` | 测试 |
| 图表被删除 | 漂移 `missing` | 测试 |
| 刚记录的清单 | 漂移为空 | 测试 |

## 已知限制（v0.1）

- 只到元数据层面：不验证记录的命令是否真的能复现图表。
- seed 通过字面量模式发现；经由配置文件或环境变量注入的 seed 会被漏掉。
- 图表只做哈希，未与生成它的脚本关联（尚无溯源图）。
- 大型数据文件只记录为“未哈希”（并记一个缺口），而不是流式处理。
- 不识别 `.gitignore`：已被忽略但实际存在的文件，只要属于数据/图表/相应扩展名，仍会被哈希。

## 许可

Apache-2.0。运行时不含第三方代码。
