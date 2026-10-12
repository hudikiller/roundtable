import { mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { checked } from "../process.js";

export async function createTls(dir: string): Promise<{ caFile: string; certFile: string; keyFile: string; caFingerprint: string }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const caFile = join(dir, "ca.crt"), caKey = join(dir, "ca.key");
  const certFile = join(dir, "bridge.crt"), keyFile = join(dir, "bridge.key");
  if (!existsSync(caFile) || !existsSync(certFile) || !existsSync(keyFile)) {
    if ([caFile, caKey, certFile, keyFile].some(existsSync)) throw new Error("TLS目录有部分证书，先核对；不覆盖已有密钥");
    await checked("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
      "-keyout", caKey, "-out", caFile, "-subj", "/CN=Feishu Codex Runner CA"]);
    await checked("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile,
      "-out", join(dir, "bridge.csr"), "-subj", "/CN=Feishu Codex Bridge"]);
    const extensions = join(dir, "bridge.ext");
    writeFileSync(extensions, "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n", { mode: 0o600 });
    await checked("openssl", ["x509", "-req", "-in", join(dir, "bridge.csr"), "-CA", caFile, "-CAkey", caKey,
      "-CAcreateserial", "-days", "365", "-out", certFile, "-extfile", extensions]);
  }
  chmodSync(caKey, 0o600); chmodSync(keyFile, 0o600); chmodSync(caFile, 0o644); chmodSync(certFile, 0o644);
  const cert = new X509Certificate(readFileSync(certFile));
  if (!cert.checkIP("127.0.0.1")) throw new Error("Bridge证书缺127.0.0.1 SAN");
  return { caFile, certFile, keyFile, caFingerprint: new X509Certificate(readFileSync(caFile)).fingerprint256 };
}
