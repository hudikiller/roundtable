import type { IncomingMessage, Session } from "./types.js";
import type { AppConfig } from "./config.js";
import type { Store } from "./store.js";
import { redact } from "./log.js";
import { L } from "./i18n.js";

export function messageReferences(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/(?:引用消息|(?:quoted|referenced?) message)[：:\s]+(om_[a-zA-Z0-9]+)/gi)) ids.add(match[1]!);
  for (const candidate of text.match(/https:\/\/[^\s<>"）]+/g) ?? []) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/, ""));
      if (!/(?:^|\.)feishu\.cn$|(?:^|\.)larksuite\.com$/.test(url.hostname)) continue;
      const id = url.searchParams.get("messageId") ?? url.searchParams.get("message_id");
      if (id && /^om_[a-zA-Z0-9]+$/.test(id)) ids.add(id);
    } catch { /* Only explicit native message links qualify. */ }
  }
  return [...ids].slice(0, 3);
}

export function referenceContext(store: Store, config: AppConfig, message: IncomingMessage, current: Session): {
  text: string; missing: number; truncated: boolean;
} {
  const lines: string[] = [];
  let missing = 0, truncated = false, budget = 8000;
  for (const id of messageReferences(message.text)) {
    // References import selected text, never another session's workspace or Codex state.
    const source = store.findSession(message.tenantId, message.chatId, [id]);
    if (!source) { missing++; continue; }
    if (source.id === current.id) continue;
    const inputs = store.query("SELECT data FROM inbound WHERE session_id=? AND created_at<=? ORDER BY created_at DESC,rowid DESC LIMIT 21",
      [source.id, message.createdAt]).map(row => JSON.parse(String(row.data)) as IncomingMessage)
      .filter(item => config.allowedMembers.includes(item.senderId))
      .map(item => ({ at: item.createdAt, label: `${item.senderName || item.senderId} | ${item.messageId}`, text: item.text }));
    const answers = store.jobs().filter(job => job.sessionId === source.id && job.response &&
      config.allowedMembers.includes(job.senderId) && (job.endedAt ?? job.createdAt) <= message.createdAt)
      .slice(-21).map(job => ({ at: job.endedAt ?? job.createdAt, label: L(`机器人回答 | 请求 ${job.messageId}`, `Bot answer | request ${job.messageId}`), text: job.response! }));
    const all = [...inputs, ...answers].sort((a, b) => a.at - b.at);
    if (all.length > 20) truncated = true;
    const selected = all.slice(-20);
    if (!selected.length) { missing++; continue; }
    lines.push(L(`显式引用消息 ${id} 所在线程的本机记录（最多近期20条）：`, `Local record of the thread of explicitly referenced message ${id} (up to the 20 most recent):`));
    for (const item of selected) {
      const line = redact(`[${item.label}] ${item.text}`);
      if (budget <= 0) { truncated = true; break; }
      lines.push(line.slice(0, budget));
      if (line.length > budget) truncated = true;
      budget -= Math.min(line.length, budget) + 1;
    }
  }
  if (missing) lines.push(L(`${missing} 个引用不在本服务已保存且可访问的同群记录中。未读取其内容，不得猜测；请用户粘贴相关原文。`,
    `${missing} reference(s) are not in the same-group records this service has saved and can access. Their content was not read; do not guess, and ask the user to paste the relevant text.`));
  if (truncated) lines.push(L("引用记录已按20条和8,000字符预算截断，不能声称覆盖完整历史。", "Referenced records were truncated to the 20-item and 8,000-character budget; do not claim they cover the full history."));
  return { text: lines.join("\n"), missing, truncated };
}
