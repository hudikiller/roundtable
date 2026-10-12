import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";

const allowed = new Set(JSON.parse(process.env.ALLOWED_HOSTS || "[]").map(h => h.toLowerCase()));
const pinned = JSON.parse(process.env.PINNED_ADDRESSES || "{}");
// Block IP literals, loopback, private, link-local, multicast and metadata IPs.
export function publicAddress(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (net.isIP(ip) === 6) {
    const low = ip.toLowerCase();
    return !["::", "::1"].includes(low) && !/^(fc|fd|fe[89ab]|ff)/.test(low) &&
      !low.startsWith("::ffff:") && !low.startsWith("2001:db8:");
  }
  return false;
}
const sockets = new Set();
const server = http.createServer((_req, res) => { res.writeHead(403); res.end("HTTPS CONNECT only"); });
server.on("connect", async (req, client, head) => {
  let upstream;
  try {
    const target = new URL(`http://${req.url}`);
    const host = target.hostname.toLowerCase();
    if (target.username || target.password || target.pathname !== "/" || target.search ||
        target.port !== "443" || net.isIP(host) || !allowed.has(host)) throw new Error("denied");
    const addresses = pinned[host]
      ? pinned[host].map(address => ({ address, family: net.isIP(address) }))
      : await lookup(host, { all: true });
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("denied");
    const first = addresses.find(a => a.family === 4) ?? addresses[0];
    upstream = net.connect({ host: first.address, family: first.family, port: 443, timeout: 15_000 });
    sockets.add(upstream);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
    client.on("close", () => upstream.destroy());
    client.on("error", () => upstream.destroy());
  } catch {
    upstream?.destroy();
    client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  }
});
server.on("connection", socket => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
});
server.listen(3128, "0.0.0.0");
process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
