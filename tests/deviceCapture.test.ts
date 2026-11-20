import { describe, expect, it } from "vitest";
import { fileRevision } from "../src/operationIdentity";
import { createDeviceCapture, deviceCaptureOperationId, deviceCapturePath, parseDeviceCapture, serializeDeviceCapture } from "../src/features/phoneInbox/deviceCapture";
import { phoneInboxOperationId } from "../src/features/phoneInbox/model";

const first = "0138e995-6341-4ff6-a82c-5710b7186912";
const second = "11ec4614-9488-4c39-b75c-a5cd3a72e1b7";
const request = "b48bc771-a866-4fac-9eea-e2aa9a380e94";
const now = new Date("2066-01-03T17:20:30.000Z");
const capture = () => createDeviceCapture(first, " 明天下午三点核对虚构纸盒。\r\n保留原话。 ", now, "Asia/Shanghai", request);

describe("immutable device capture identity", () => {
  it("round trips exact original text and anchors the date to the recording device", () => {
    const row = capture();
    const decoded = parseDeviceCapture(serializeDeviceCapture(row), deviceCapturePath(row));
    expect(decoded.text).toBe(" 明天下午三点核对虚构纸盒。\r\n保留原话。 ");
    expect(decoded.date).toBe("2066-01-04");
    expect(decoded.recordedAt).toBe(now.toISOString());
    expect(Object.isFrozen(decoded)).toBe(true);
  });
  it("keeps an operation identity on replay that older phone receipts can read", () => {
    const row = capture();
    const restored = parseDeviceCapture(serializeDeviceCapture(row), deviceCapturePath(row));
    expect(deviceCaptureOperationId(restored)).toBe(deviceCaptureOperationId(row));
    expect(phoneInboxOperationId(deviceCaptureOperationId(row))).toBe(true);
  });
  it("separates two devices even when their request ID and text happen to match", () => {
    const a = capture(), b = createDeviceCapture(second, a.text, now, "Asia/Shanghai", request);
    expect(deviceCapturePath(a)).not.toBe(deviceCapturePath(b));
    expect(deviceCaptureOperationId(a)).not.toBe(deviceCaptureOperationId(b));
  });
  it("allocates a fresh request for the same sentence said twice", () => {
    const a = createDeviceCapture(first, "纯虚构蓝纸", now, "Asia/Shanghai");
    const b = createDeviceCapture(first, a.text, now, "Asia/Shanghai");
    expect(a.requestId).not.toBe(b.requestId);
    expect(deviceCaptureOperationId(a)).not.toBe(deviceCaptureOperationId(b));
  });
  it("does not turn edited original text under the same request ID into another operation", () => {
    const a = capture(), text = "纯虚构的更正，需要核对";
    const b = { ...a, text, textRevision: fileRevision(text) };
    expect(deviceCaptureOperationId(b)).toBe(deviceCaptureOperationId(a));
  });
  it("rejects an unreviewed edit that no longer matches the text revision", () => {
    const row = capture();
    expect(() => parseDeviceCapture(JSON.stringify({ ...row, text: "已改动" }), deviceCapturePath(row))).toThrow();
  });
  it.each(["../other.json", "输入/设备随手记/" + second + "/" + request + ".json",
    "输入/设备随手记/" + first + "/" + request + " (conflict).json"])("rejects a moved or conflicting source path: %s", path => {
    expect(() => parseDeviceCapture(serializeDeviceCapture(capture()), path)).toThrow();
  });
  it.each([{ tool: "delete_task" }, { executionRole: "owner" }, { version: 2 }])("rejects unrecognized execution metadata: %j", fields => {
    const row = capture();
    expect(() => parseDeviceCapture(JSON.stringify({ ...row, ...fields }), deviceCapturePath(row))).toThrow();
  });
  it("keeps the original local date when the same instant is still yesterday elsewhere", () => {
    const row = createDeviceCapture(first, "纯虚构记录", now, "America/Los_Angeles", request);
    expect(row.date).toBe("2066-01-03");
    expect(() => parseDeviceCapture(JSON.stringify({ ...row, date: "2066-01-04" }), deviceCapturePath(row))).toThrow();
  });
  it.each(["", "invalid/time-zone"])("rejects a missing or invalid recording timezone: %s", zone => {
    expect(() => createDeviceCapture(first, "纯虚构记录", now, zone, request)).toThrow();
  });
  it.each(["", " \n ", "纸".repeat(4001)])("rejects blank or over-limit UTF-8 original text", text => {
    expect(() => createDeviceCapture(first, text, now, "Asia/Shanghai", request)).toThrow();
  });
  it("rejects invalid IDs, timestamps, JSON and an oversized envelope", () => {
    expect(() => createDeviceCapture("../escape", "纯虚构记录", now, "Asia/Shanghai", request)).toThrow();
    const row = capture();
    expect(() => parseDeviceCapture(JSON.stringify({ ...row, recordedAt: "2066-02-30T00:00:00.000Z" }), deviceCapturePath(row))).toThrow();
    expect(() => parseDeviceCapture("{", deviceCapturePath(row))).toThrow();
    expect(() => parseDeviceCapture(" ".repeat(74001), deviceCapturePath(row))).toThrow();
  });
});
