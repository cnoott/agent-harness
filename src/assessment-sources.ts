/** Host-owned public source captures. No browser cookies, workspace files, or credentials. */
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

export function publicAddress(address: string): boolean {
  // IPv4 only for a simple, auditable pinned lookup; no IPv4-mapped IPv6 bypasses.
  if (isIP(address) !== 4) return false;
  const [a,b] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19].includes(b)));
}
export async function capturePublicSource(input: unknown, redirects = 0): Promise<any> {
  if (typeof input !== "string" || input.length > 2000 || redirects > 3) throw new Error("Invalid source URL or too many redirects");
  const url = new URL(input);
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || isIP(url.hostname)) throw new Error("Sources must be public HTTPS websites without credentials");
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error("Private network sources are not allowed");
  const result = await new Promise<{status: number; location?: string; body: string; contentType: string}>((resolve, reject) => {
    const req = request(url, { headers: { "User-Agent": "SportsEvidence/1.0", Accept: "text/html,text/plain" }, lookup: ((_hostname: any, options: any, callback: any) => options.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4)) as any }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 1_000_000) req.destroy(new Error("Source exceeds 1 MB capture limit")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, location: response.headers.location, body: Buffer.concat(chunks).toString("utf8"), contentType: response.headers["content-type"] ?? "" }));
    });
    req.setTimeout(20_000, () => req.destroy(new Error("Source capture timed out")));
    req.on("error", reject); req.end();
  });
  if ([301,302,303,307,308].includes(result.status) && result.location) return capturePublicSource(new URL(result.location,url).href, redirects + 1);
  if (result.status !== 200 || !/text\/(html|plain)/i.test(result.contentType)) throw new Error(`Source cannot be captured (${result.status}); use another source or report missing evidence`);
  const text = result.body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g," ").trim().slice(0,100_000);
  if (text.length < 80) throw new Error("Source has insufficient readable text");
  return { capture_id: randomUUID(), source_url: url.href, captured_at: new Date().toISOString(), text, sha256: createHash("sha256").update(text).digest("hex") };
}
