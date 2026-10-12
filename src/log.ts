let sensitive: string[] = [];
export function setSecrets(values: string[]): void {
  sensitive = values.filter(v => v.length > 5).sort((a, b) => b.length - a.length);
}
export function redact(value: string): string {
  let text = value;
  for (const secret of sensitive) text = text.replaceAll(secret, "[REDACTED]");
  return text.replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, "[REDACTED]");
}
export function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 1500);
}
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(redact(JSON.stringify({ time: new Date().toISOString(), event, ...fields })));
}
