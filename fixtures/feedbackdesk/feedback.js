// 验收起点：演示简单导入，但尚未处理整批冲突。
export function importFeedback(existing, incoming) {
  const result = new Map(existing.map(row => [row.id, { ...row }]));
  for (const row of incoming) result.set(row.id, { ...row });
  return [...result.values()];
}
