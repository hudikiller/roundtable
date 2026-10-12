import { writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { L } from "./i18n.js";

/** Persist contents and directory entries before recording an acknowledgement in SQLite. */
export function writeDurableFile(file: string, data: Uint8Array, root: string): void {
  const boundary = resolve(root);
  let directory = dirname(resolve(file));
  const inside = relative(boundary, directory);
  if (inside === ".." || inside.startsWith(`..${sep}`) || inside.startsWith(sep))
    throw new Error(L("持久文件不在批准的数据目录中", "Durable file is outside the approved data directory"));
  writeFileSync(file, data, { mode: 0o600, flush: true });
  for (;;) {
    const descriptor = openSync(directory, "r");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    if (directory === boundary) break;
    directory = dirname(directory);
  }
}
