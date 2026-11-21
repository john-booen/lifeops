export function isLiteralTaskConfirmation(text: string): boolean {
  const answer = text.trim().replace(/[。！？.!?]+$/u, "").trim();
  return ["确认", "确定", "是"].includes(answer);
}
