import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { formatLocalTime } from "../src/date";

const moduleUrl = pathToFileURL(resolve("src/date.ts")).href;

function displayInTimeZone(timeZone: string, timestamps: string[]): string[] {
  // Each process gets its own real local time zone; do not change the test runner's TZ.
  const child = spawnSync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e",
    `const { formatLocalTime } = await import(${JSON.stringify(moduleUrl)});
     process.stdout.write(JSON.stringify(${JSON.stringify(timestamps)}.map(formatLocalTime)));`
  ], {
    encoding: "utf8", timeout: 10000, env: { ...process.env, TZ: timeZone }
  });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as string[];
}

describe("local completion time display", () => {
  it("shows China local time for UTC or offset timestamps, including the next calendar day", () => {
    expect(displayInTimeZone("Asia/Shanghai", [
      "2026-09-13T01:51:00.000Z",
      "2026-09-12T16:05:00.000Z",
      "2026-09-13T09:51:00+08:00"
    ])).toEqual(["09:51", "00:05", "09:51"]);
  });

  it("uses the date's local offset across the previous calendar day and daylight saving changes", () => {
    expect(displayInTimeZone("America/New_York", [
      "2026-09-13T01:51:00.000Z",
      "2026-01-13T01:51:00.000Z",
      "2026-03-08T06:59:00.000Z",
      "2026-03-08T07:00:00.000Z"
    ])).toEqual(["21:51", "20:51", "01:59", "03:00"]);
  });

  it("also respects a UTC device instead of assuming the user is always in China", () => {
    expect(displayInTimeZone("UTC", [
      "2026-09-13T01:51:00.000Z",
      "2026-09-13T00:05:00+08:00"
    ])).toEqual(["01:51", "16:05"]);
  });

  it("uses the current device's clock when no time zone is supplied", () => {
    expect(formatLocalTime(new Date(2026, 8, 13, 9, 5).toISOString())).toBe("09:05");
  });

  it.each(["", "not-a-date", "2026-09-13", "2026-13-13T01:51:00Z", "2026-09-13T25:51:00Z"])(
    "returns an empty display for missing or invalid timestamp %j, allowing the UI to show 已完成",
    timestamp => { expect(formatLocalTime(timestamp)).toBe(""); }
  );
});
