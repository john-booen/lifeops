# One full check for an immutable source commit

Small changes use focused tests. A candidate commit runs the full isolated source job once, together with the separate dependency audit. Formal fictional-provider evaluation and native Obsidian checks remain separate release gates.

The source job archives `source-ci-evidence-<40-character SHA>` only after all eight required stages pass. It contains the original CI result, Vitest JSON report, coverage summary and provenance, and the six-file verified plugin package. `evidence.json` records their sizes and SHA-256 hashes, the exact source commit, original runner root, version, test counters, package fingerprints and GitHub run/attempt. No vault, profile or plugin settings are included.

The coverage reader maps original absolute report paths to the current checkout while preserving the original report bytes and hash. It still checks the five required source hashes, policy, file set and current per-file baseline. Changed source, package, report, identity, incomplete stages or counters fail verification.

Before a full workflow, a read-only planner checks the same repository and exact SHA for a successful full source run and dependency audit completed within 24 hours, with a live immutable artifact. A native-only run, a reuse-only run, a pull request run or unrelated workflow cannot qualify. If found, the reuse job downloads that artifact by ID and verifies it against the same Git checkout. Promoting the same commit from `dev` to `main` therefore does not repeat the full suite. API lookup errors fail planning instead of automatically starting another full suite; missing or expired evidence requires a new full check. Dependency-audit evidence belongs to that source run and is not a claim about future advisory updates.

Full verification and native QA have separate concurrency groups so dispatching one does not cancel the other. The workflow only reads repository/Actions data. Release installation still requires all existing formal/native gates, source/package matching, backup, safe reload and a fresh heartbeat. This tooling does not install a plugin or reload a desktop.

To verify an already downloaded archive in its exact source checkout:

```sh
node scripts/ci-evidence.mjs --verify /path/to/source-ci-evidence EXACT_SOURCE_SHA
```

GitHub API and artifact inputs follow the official [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs), [artifact API](https://docs.github.com/en/rest/actions/artifacts) and [download-artifact action](https://github.com/actions/download-artifact/tree/v4). Do not replace a failed product run with edited reports or change source identity to reuse an older result.
