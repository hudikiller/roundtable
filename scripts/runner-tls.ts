import { resolve } from "node:path";
import { createTls } from "../src/runner/tls.js";
import { errorText } from "../src/log.js";
import { L } from "../src/i18n.js";

if (!process.argv[2]) throw new Error(L("用法：npm run runner:tls -- <专用证书目录>", "Usage: npm run runner:tls -- <dedicated certificate directory>"));
createTls(resolve(process.argv[2])).then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(e => { console.error(errorText(e)); process.exitCode = 1; });
