// Read-only metadata preflight for the public LifeOps repository. No credentials or submission API.
const repo = process.argv[2] ?? "john-booen/lifeops";
if (process.argv.length > 3 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) {
  throw Error("Usage: node scripts/community-preflight.mjs [owner/repository]");
}
const api = "https://api.github.com/repos/" + repo;
async function read(url, label, json = true) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw Error(`${label}: public HTTP ${response.status}`);
  return json ? response.json() : response.text();
}
try {
  const [repository, release] = await Promise.all([
    read(api, "repository"), read(api + "/releases/latest", "latest release")
  ]);
  const branch = repository.default_branch;
  if (typeof branch !== "string" || !branch) throw Error("Default branch unavailable");
  const raw = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/`;
  const [manifest, readme, license, head, catalog] = await Promise.all([
    read(raw + "manifest.json", "default-branch manifest"),
    read(raw + "README.md", "README", false),
    read(raw + "LICENSE", "LICENSE", false),
    read(api + "/commits/" + encodeURIComponent(branch), "default-branch commit"),
    read("https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json", "official registry")
  ]);
  if (!Array.isArray(catalog)) throw Error("Official registry shape changed");
  const runs = await read(api + "/actions/runs?head_sha=" + head.sha + "&per_page=30", "default-branch checks");
  if (!Array.isArray(runs.workflow_runs)) throw Error("Workflow result shape changed");
  const verification = runs.workflow_runs.filter(run => run.name === "LifeOps isolated verification")
    .sort((a, b) => b.id - a.id)[0];
  const conflicts = catalog.filter(row => row.id === manifest.id && row.repo !== repo);
  const own = catalog.filter(row => row.repo === repo);
  const assetNames = Array.isArray(release.assets) ? release.assets.map(asset => asset.name) : [];
  const expected = ["main.js", "manifest.json", "styles.css", "LICENSE", "RESOURCE-MANIFEST.json", "SHA256SUMS.txt"];
  const semver = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;
  const checks = {
    publicRepository: repository.visibility === "public" && repository.archived === false,
    matchingRepository: repository.full_name === repo,
    rootReadme: typeof readme === "string" && readme.trim().length > 0,
    rootLicense: typeof license === "string" && license.startsWith("MIT License"),
    pluginId: typeof manifest.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.id),
    description: typeof manifest.description === "string" && manifest.description.length <= 250 && manifest.description.endsWith("."),
    version: typeof manifest.version === "string" && semver.test(manifest.version),
    declaredMinimum: typeof manifest.minAppVersion === "string" && semver.test(manifest.minAppVersion),
    desktopOnly: manifest.isDesktopOnly === true,
    releaseMatchesManifest: release.tag_name === manifest.version && release.draft === false && release.prerelease === false,
    releaseAssetsPresent: expected.every(name => assetNames.includes(name)),
    officialRegistryIdAvailable: conflicts.length === 0,
    defaultBranchVerification: verification?.status === "completed" && verification.conclusion === "success"
  };
  const result = {
    checkedAt: new Date().toISOString(), repository: repo, branch, sourceCommit: head.sha,
    release: { version: release.tag_name, url: release.html_url, assetNames }, manifest,
    checks, metadataChecksPassed: Object.values(checks).every(Boolean),
    registry: { url: "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json", count: catalog.length, own, conflicts },
    verification: verification ? { id: verification.id, url: verification.html_url, status: verification.status, conclusion: verification.conclusion } : null,
    manualReviewRequired: ["Application compatibility and source-policy review", "Current Community directory ownership and listing status", "Obsidian account login and GitHub ownership connection"],
    officialSubmissionGuide: "https://docs.obsidian.md/plugins/releasing/submit-plugin",
    submissionPerformed: false, accountConnectionPerformed: false
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.metadataChecksPassed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "Public metadata preflight unavailable");
  process.exitCode = 1;
}
