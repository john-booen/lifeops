import { randomUUID } from "node:crypto";
import { fileRevision } from "../../operationIdentity";
import { phoneInboxWriteId } from "./model";

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u;
const CAPTURE_ROOT = "输入/设备随手记";
const MAX_TEXT_BYTES = 12_000;
const KEYS = ["version", "deviceId", "requestId", "recordedAt", "timeZone", "date", "text", "textRevision"];

/** Immutable input, not authorization to execute a tool or change a device role. */
export interface DeviceCapture {
  version: 1;
  deviceId: string;
  requestId: string;
  recordedAt: string;
  timeZone: string;
  date: string;
  text: string;
  textRevision: string;
}

function invalid(): never { throw Error("设备记录格式有变化，请保留原文并重新核对。"); }
function calendarDay(recordedAt: string, timeZone: string): string {
  const instant = new Date(recordedAt);
  if (!Number.isFinite(+instant) || instant.toISOString() !== recordedAt || timeZone.length > 80) invalid();
  try { return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(instant); }
  catch { return invalid(); }
}
function validate(value: unknown): DeviceCapture {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(row, key))
    || row.version !== 1 || typeof row.deviceId !== "string" || !UUID.test(row.deviceId)
    || typeof row.requestId !== "string" || !UUID.test(row.requestId)
    || typeof row.recordedAt !== "string" || typeof row.timeZone !== "string"
    || typeof row.date !== "string" || typeof row.text !== "string" || !row.text.trim()
    || new TextEncoder().encode(row.text).byteLength > MAX_TEXT_BYTES
    || typeof row.textRevision !== "string" || row.textRevision !== fileRevision(row.text)
    || row.date !== calendarDay(row.recordedAt, row.timeZone)) invalid();
  return Object.freeze({ ...row }) as unknown as DeviceCapture;
}

export function createDeviceCapture(deviceId: string, text: string, now: Date, timeZone: string,
  requestId = randomUUID()): DeviceCapture {
  const recordedAt = now.toISOString();
  return validate({ version: 1, deviceId, requestId, recordedAt, timeZone,
    date: calendarDay(recordedAt, timeZone), text, textRevision: fileRevision(text) });
}

export function deviceCapturePath(value: DeviceCapture): string {
  const row = validate(value);
  return CAPTURE_ROOT + "/" + row.deviceId + "/" + row.requestId + ".json";
}

export function serializeDeviceCapture(value: DeviceCapture): string {
  const row = validate(value);
  return JSON.stringify(Object.fromEntries(KEYS.map(key => [key, row[key as keyof DeviceCapture]])), null, 2) + "\n";
}

export function parseDeviceCapture(raw: string, path: string): DeviceCapture {
  // Bound decoding as well as the original text. Do not silently ignore extra tool fields.
  if (new TextEncoder().encode(raw).byteLength > MAX_TEXT_BYTES * 6 + 2_000) invalid();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalid(); }
  const row = validate(value);
  if (deviceCapturePath(row) !== path) invalid();
  return row;
}

/** Stable across retries and text edits; changed content must never become a second operation. */
export function deviceCaptureOperationId(value: DeviceCapture): string {
  const row = validate(value);
  return phoneInboxWriteId("device-capture:" + row.deviceId + ":" + row.requestId);
}
