import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it("checks reviewed image bytes in the working tree, index and history", async () => {
  const root = await mkdtemp(join(tmpdir(), "lifeops-public-image-"));
  const script = "scripts/verify-public-boundary.mjs";
  const image = "tests/fixtures/trade-screenshots/equity-match.png";
  const extra = "tests/fixtures/trade-screenshots/extra-sample.png";
  const terms = join(root, "synthetic-terms.txt");
  const vault = join(root, "repo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: vault, stdio: "pipe" });
  const scan = (mode: string) => spawnSync(process.execPath, [join(vault, script), mode], {
    encoding: "utf8",
    env: { ...process.env, LIFEOPS_SENSITIVE_TERMS_FILE: terms }
  });

  try {
    await mkdir(join(vault, dirname(script)), { recursive: true });
    await mkdir(join(vault, dirname(image)), { recursive: true });
    await copyFile(resolve(script), join(vault, script));
    const approved = await readFile(resolve(image));
    await writeFile(join(vault, image), approved);
    await writeFile(terms, "fictional phrase for privacy tests\n");
    git("init", "--quiet");
    git("config", "core.hooksPath", "/dev/null");
    git("config", "user.name", "Fictional Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("add", "--", script, image);
    git("commit", "--quiet", "-m", "Review the fictional image");
    expect(scan("--all").status).toBe(0);
    expect(scan("--history").status).toBe(0);

    await writeFile(join(vault, image), Buffer.concat([approved, Buffer.from("fictional image change")]));
    expect(scan("--all")).toMatchObject({ status: 1, stderr: expect.stringContaining(image) });
    git("add", "--", image);
    expect(scan("--staged")).toMatchObject({ status: 1, stderr: expect.stringContaining(image) });
    git("restore", "--staged", "--worktree", "--", image);

    await writeFile(join(vault, extra), approved);
    git("add", "--", extra);
    expect(scan("--staged")).toMatchObject({ status: 1, stderr: expect.stringContaining(extra) });
    git("commit", "--quiet", "-m", "Add the unreviewed image path");
    git("revert", "--no-edit", "HEAD");
    expect(scan("--all").status).toBe(0);
    expect(scan("--history")).toMatchObject({ status: 1, stderr: expect.stringContaining(extra) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("checks commit metadata and annotated tags only from a complete history", async () => {
  const root = await mkdtemp(join(tmpdir(), "lifeops-public-history-"));
  const script = "scripts/verify-public-boundary.mjs";
  const repo = join(root, "repo");
  const shallow = join(root, "shallow");
  const terms = join(root, "synthetic-terms.txt");
  const privatePhrase = "fictional phrase only in commit metadata";
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const scan = (cwd: string) => spawnSync(process.execPath, [join(cwd, script), "--history"], {
    encoding: "utf8",
    env: { ...process.env, LIFEOPS_SENSITIVE_TERMS_FILE: terms }
  });

  try {
    await mkdir(join(repo, dirname(script)), { recursive: true });
    await copyFile(resolve(script), join(repo, script));
    await writeFile(terms, privatePhrase + "\n");
    git(repo, "init", "--quiet");
    git(repo, "config", "core.hooksPath", "/dev/null");
    git(repo, "config", "user.name", "Fictional Fixture");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "add", "--", script);
    git(repo, "commit", "--quiet", "-m", "Clean commit");
    git(repo, "tag", "-a", "clean-tag", "-m", "Clean release note");
    expect(scan(repo).status).toBe(0);

    const fakeKey = ["ghp", "Q".repeat(36)].join("_");
    git(repo, "tag", "-a", "sample-tag", "-m", fakeKey);
    const tagged = scan(repo);
    expect(tagged).toMatchObject({ status: 1, stderr: expect.stringMatching(/密钥格式: tag [a-f0-9]+/u) });
    expect(tagged.stderr).not.toContain(fakeKey);
    git(repo, "tag", "-d", "sample-tag");

    git(repo, "commit", "--quiet", "--allow-empty", "-m", privatePhrase);
    git(repo, "commit", "--quiet", "--allow-empty", "-m", "Clean tip");
    const history = scan(repo);
    expect(history).toMatchObject({ status: 1, stderr: expect.stringMatching(/命中敏感词: commit [a-f0-9]+/u) });
    expect(history.stderr).not.toContain(privatePhrase);

    git(root, "clone", "--quiet", "--depth=1", "--no-tags", "file://" + repo, shallow);
    expect(scan(shallow)).toMatchObject({ status: 1, stderr: expect.stringContaining("历史检查需要完整 Git 历史") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
