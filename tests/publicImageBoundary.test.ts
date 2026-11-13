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
