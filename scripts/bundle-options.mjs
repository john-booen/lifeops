import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

export function bundleOptions(args) {
  const options = { production: false, watch: false, outfile: "main.js", explicitOutput: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "production") options.production = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--outfile" && !options.explicitOutput && args[index + 1] && !args[index + 1].startsWith("--")) {
      options.outfile = resolve(args[++index]); options.explicitOutput = true;
    } else throw new Error("Usage: esbuild.config.mjs [production] [--watch] [--outfile NEW_FILE]");
  }
  return options;
}

export async function assertFreshBundleOutput(options) {
  if (!options.explicitOutput) return;
  try { await lstat(options.outfile); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Explicit bundle output already exists; choose a new file");
}
