import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function requireValue(condition, message) { if (!condition) throw new Error(message); }
const key = ({ name, version }) => `${name}@${version}`;
const labels = { LOW: 1, MODERATE: 2, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const scoreRank = score => score >= 9 ? 4 : score >= 7 ? 3 : score >= 4 ? 2 : 1;
const noErrors = item => !Object.hasOwn(item, "error") && (!Object.hasOwn(item, "errors") || (Array.isArray(item.errors) && item.errors.length === 0));

// This is an output/coverage gate. Vulnerability matching remains in official OSV.
export function npmLockPackages(lock) {
  requireValue(lock?.lockfileVersion === 3 && lock.packages && typeof lock.packages === "object" && !Array.isArray(lock.packages), "Unsupported npm lockfile");
  const packages = new Map();
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (location === "") continue;
    requireValue(entry && typeof entry === "object" && !entry.link && !entry.inBundle, `Unsupported local/link/bundled entry: ${location}`);
    requireValue(/^(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)*node_modules\/(?:@[^/]+\/)?[^/]+$/.test(location), `Unsupported package location: ${location}`);
    const installedName = location.slice(location.lastIndexOf("node_modules/") + 13);
    const name = entry.name ?? installedName;
    requireValue(name === installedName && /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/.test(name), `Unsupported alias/name: ${location}`);
    requireValue(typeof entry.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version), `Missing/unsupported version: ${location}`);
    let registry;
    try { registry = new URL(entry.resolved); } catch { throw new Error(`Missing/unsupported registry source: ${location}`); }
    const tarballName = name.split("/").at(-1);
    requireValue(registry.protocol === "https:" && registry.hostname === "registry.npmjs.org" && !registry.port && !registry.username && !registry.password && !registry.search && !registry.hash && decodeURIComponent(registry.pathname) === `/${name}/-/${tarballName}-${entry.version}.tgz`, `Unsupported Git/local/non-npm source or tarball version mismatch: ${location}`);
    requireValue(typeof entry.integrity === "string" && /^(?:sha512|sha256)-[A-Za-z0-9+/]+=*$/.test(entry.integrity), `Missing package integrity: ${location}`);
    packages.set(key({ name, version: entry.version }), { name, version: entry.version });
  }
  requireValue(packages.size > 0, "Empty package inventory");
  return packages;
}

export function evaluateOsvReport({ packageLock, expectedLockSourcePath, scannerResult, scannerExitCode, scannerStderr = "", scannerSignal = null, scannerError = null }) {
  requireValue(!scannerSignal && !scannerError && [0, 1].includes(scannerExitCode), "Scanner did not complete normally (error/signal/timeout/exit)");
  const normalLog = /^(?:Starting filesystem walk for root: .+|Scanned .+ file and found \d+ packages|End status: \d+ dirs visited, \d+ inodes visited, \d+ Extract calls, .+ elapsed, .+ wall time|Loaded npm local db from .+)$/;
  requireValue(typeof scannerStderr === "string" && scannerStderr.split(/\r?\n/).every(line => !line.trim() || normalLog.test(line)), "Scanner reported an error or unexpected diagnostic");
  const expected = npmLockPackages(packageLock);
  requireValue(typeof expectedLockSourcePath === "string" && resolve(expectedLockSourcePath) === expectedLockSourcePath, "Expected source must be an absolute lockfile path");
  requireValue(scannerResult && Array.isArray(scannerResult.results) && scannerResult.results.length === 1, "Missing/incomplete or unexpected result sources");
  requireValue(noErrors(scannerResult), "Report contains scanner errors or malformed error fields");
  const result = scannerResult.results[0];
  requireValue(result.source?.type === "lockfile" && result.source.path === expectedLockSourcePath && Array.isArray(result.packages), "Incorrect lockfile source");
  requireValue(noErrors(result), "Source contains scanner errors");
  const seen = new Set(), findings = [];
  for (const row of result.packages) {
    const pkg = row?.package;
    requireValue(pkg?.ecosystem === "npm" && typeof pkg.name === "string" && typeof pkg.version === "string", "Unsupported report package");
    const identity = key(pkg);
    requireValue(expected.has(identity) && !seen.has(identity), `Unexpected/duplicate/version-mismatched package: ${identity}`);
    requireValue(noErrors(row), `Package error: ${identity}`);
    seen.add(identity);
    const vulnerabilities = Object.hasOwn(row, "vulnerabilities") ? row.vulnerabilities : [], groups = Object.hasOwn(row, "groups") ? row.groups : [];
    requireValue(Array.isArray(vulnerabilities) && Array.isArray(groups), `Malformed findings: ${identity}`);
    const byId = new Map();
    for (const vulnerability of vulnerabilities) {
      const id = vulnerability?.id, label = vulnerability?.database_specific?.severity;
      requireValue(typeof id === "string" && id.length > 0 && !byId.has(id), `Missing/duplicate advisory ID: ${identity}`);
      requireValue(Object.hasOwn(labels, label), `Unknown/missing advisory severity: ${identity} ${id}`);
      requireValue(Array.isArray(vulnerability.affected) && vulnerability.affected.some(item => item.package?.ecosystem === "npm" && item.package.name === pkg.name), `Advisory package mismatch: ${id}`);
      byId.set(id, { name: pkg.name, version: pkg.version, id, severity: label, rank: labels[label] });
    }
    const groupedIds = new Set();
    for (const group of groups) {
      requireValue(Array.isArray(group.ids) && group.ids.length > 0 && typeof group.max_severity === "string" && /^(?:\d+(?:\.\d+)?)$/.test(group.max_severity), `Unknown/missing group severity: ${identity}`);
      const score = Number(group.max_severity);
      requireValue(Number.isFinite(score) && score >= 0 && score <= 10, `Invalid severity score: ${identity}`);
      let maxRank = 0;
      for (const id of group.ids) {
        requireValue(byId.has(id) && !groupedIds.has(id), `Missing/extra/duplicate grouped advisory: ${identity} ${id}`);
        groupedIds.add(id); maxRank = Math.max(maxRank, byId.get(id).rank);
      }
      requireValue(maxRank === scoreRank(score), `Conflicting label/group severity: ${identity}`);
      for (const id of group.ids) findings.push({ ...byId.get(id), groupMaxSeverity: score, blocking: byId.get(id).rank >= 3 || score >= 7 });
    }
    requireValue(groupedIds.size === byId.size, `Ungrouped advisory: ${identity}`);
  }
  requireValue(seen.size === expected.size && [...expected.keys()].every(identity => seen.has(identity)), "Incomplete package coverage");
  requireValue(scannerExitCode === (findings.length ? 1 : 0), "Scanner exit code contradicts findings");
  const blocking = findings.filter(item => item.blocking);
  return { schemaVersion: 1, gate: blocking.length ? "fail" : "pass", source: expectedLockSourcePath, expectedPackageVersions: expected.size, observedPackageVersions: seen.size, scannerExitCode, highCritical: blocking.length, lowerSeverityFindings: findings.filter(item => !item.blocking), blockingFindings: blocking, allVulnerabilitiesZero: findings.length === 0 };
}

export async function gateFiles({ lockPath, reportPath, statusPath, outputPath }) {
  const status = JSON.parse(await readFile(statusPath, "utf8"));
  const result = evaluateOsvReport({ packageLock: JSON.parse(await readFile(lockPath, "utf8")), expectedLockSourcePath: resolve(lockPath), scannerResult: JSON.parse(await readFile(reportPath, "utf8")), scannerExitCode: status.scannerExitCode, scannerStderr: status.scannerStderr, scannerSignal: status.scannerSignal, scannerError: status.scannerError });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [lockPath, reportPath, statusPath, outputPath, ...extra] = process.argv.slice(2);
  try {
    requireValue(outputPath && extra.length === 0, "Usage: osv-audit-gate.mjs LOCK REPORT STATUS OUTPUT");
    const result = await gateFiles({ lockPath, reportPath, statusPath, outputPath });
    console.log(JSON.stringify({ gate: result.gate, packageVersions: result.observedPackageVersions, highCritical: result.highCritical, lowerSeverity: result.lowerSeverityFindings.length, scannerExitCode: result.scannerExitCode }));
    if (result.gate !== "pass") process.exitCode = 1;
  } catch (error) { console.error(`OSV gate rejected: ${error.message}`); process.exitCode = 2; }
}
