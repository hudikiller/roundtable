import { resolve } from "node:path";
import { createTls } from "../src/runner/tls.js";
import { errorText } from "../src/log.js";

if (!process.argv[2]) throw new Error("用法：npm run runner:tls -- <专用证书目录>");
createTls(resolve(process.argv[2])).then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(e => { console.error(errorText(e)); process.exitCode = 1; });
