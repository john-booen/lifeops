export function isLiteralTaskConfirmation(text: string): boolean {
  const answer = text.trim().replace(/[。！？.!?]+$/u, "").trim();
  return ["确认", "确定", "是"].includes(answer);
}

/** Shared by the desktop adjacent-card protocol and its remote host. */
export function isLiteralTaskCancellation(text: string): boolean {
  return /^(?:取消|算了|不用了|先不保存)[。！？.!?]*$/u.test(text.trim());
}
