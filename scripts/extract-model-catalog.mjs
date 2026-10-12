#!/usr/bin/env node
// Copy metadata for selected models from your own Codex catalog into the task image build context.
// Codex warns "Model metadata for `X` not found" for models it does not know; without metadata,
// context limits and tools (e.g. web search) may fall back to defaults.
//   node scripts/extract-model-catalog.mjs ~/.codex/model_catalog.json gpt-6.1-sol gpt-6-astra
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const [source, ...slugs] = process.argv.slice(2);
if (!source || !slugs.length) {
  console.error("usage: node scripts/extract-model-catalog.mjs <codex model_catalog.json> <model> [model...]");
  process.exit(1);
}
const catalog = JSON.parse(readFileSync(source, "utf8"));
const models = (catalog.models ?? []).filter(m => slugs.includes(m.slug));
const missing = slugs.filter(s => !models.some(m => m.slug === s));
if (missing.length) { console.error(`not found in catalog: ${missing.join(", ")}`); process.exit(1); }
mkdirSync(new URL("../docker/models/", import.meta.url), { recursive: true });
writeFileSync(new URL("../docker/models/model_catalog.json", import.meta.url), JSON.stringify({ models }, null, 1));
console.log(`wrote docker/models/model_catalog.json with ${models.length} model(s); rebuild the task image`);
