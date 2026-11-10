import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lifeops-vault-key-boundary-"));
  await mkdir(join(root, "scripts"));
  await cp(new URL("../scripts/verify-test-vault.mjs", import.meta.url), join(root, "scripts", "verify-test-vault.mjs"));
  await cp(new URL("../fixtures/test-vault", import.meta.url), join(root, "test-vault"), { recursive: true });
  const pluginArtifacts: Record<string, string> = {};
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    const content = file === "manifest.json" ? '{"id":"lifeops-assistant"}' : "/* synthetic artifact */\n";
    await writeFile(join(root, file), content);
    await writeFile(join(root, "test-vault", ".obsidian", "plugins", "lifeops-assistant", file), content);
    pluginArtifacts[file] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(join(root, "test-vault", "TEST_VAULT_INFO.json"), JSON.stringify({ pluginArtifacts }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Test Vault credential boundary using the actual verifier in a temporary workspace", () => {
  const taskId = "task-1789005536989-lu7mcg17";
  const syntheticKey = `sk-${"f".repeat(16)}`;
  const syntheticBearer = `Bearer ${"b".repeat(16)}`;
  it.each([
    { label: "task ID in Markdown", file: "note.md", content: `Task: ${taskId}`, allowed: true },
    { label: "task ID retained in reverted Ledger JSON", file: "ledger.json", content: JSON.stringify({ status: "reverted", undo: { taskId } }), allowed: true },
    { label: "standalone sk token at the beginning", file: "note.md", content: syntheticKey, allowed: false },
    { label: "sk token inside a JSON value", file: "note.json", content: JSON.stringify({ apiKey: syntheticKey }), allowed: false },
    { label: "sk token after a nonalphanumeric separator", file: "note.txt", content: `credential_${syntheticKey}`, allowed: false },
    { label: "Bearer header", file: "note.txt", content: `Authorization: ${syntheticBearer}`, allowed: false },
    { label: "task ID followed by an actual token", file: "note.md", content: `${taskId}\n${syntheticKey}`, allowed: false }
  ])("handles $label without masking actual tokens", async ({ file, content, allowed }) => {
    const sample = join(root, "test-vault", file);
    await writeFile(sample, content);
    let result: { stdout: string; stderr: string; code: number };
    try {
      const output = await run(process.execPath, [join(root, "scripts", "verify-test-vault.mjs")], { cwd: root });
      result = { ...output, code: 0 };
    } catch (error) {
      const failure = error as { stdout: string; stderr: string; code: number };
      result = { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
    }
    expect(result.code === 0).toBe(allowed);
    if (allowed) expect(result.stdout).toContain("Verified isolated Test Vault");
    else expect(result.stderr).toContain("Possible API key found");
    expect(await readFile(sample, "utf8")).toBe(content);
  });
});
