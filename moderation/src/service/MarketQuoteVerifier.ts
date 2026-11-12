import http from "http";
import https from "https";
import { MarketBet } from "@betstan/common";

export async function verifyMarketQuote(ownerId: string, quote: MarketBet): Promise<boolean> {
  const serviceUrl = process.env.EVENT_SERVICE_URL;
  if (!serviceUrl) throw new Error("EVENT_SERVICE_URL is not configured");
  const url = new URL(`/api/event/market-quotes/${encodeURIComponent(quote.quoteId)}/validate`, serviceUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("EVENT_SERVICE_URL must use HTTP or HTTPS");
  const body = JSON.stringify({ ownerId, quote });
  return new Promise<boolean>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16384) { request.destroy(new Error("Oversized market authority response")); return; }
        chunks.push(chunk);
      });
      response.on("error", error => { clearTimeout(deadline); reject(error); });
      response.on("end", () => {
        clearTimeout(deadline);
        if (response.statusCode === 400 || response.statusCode === 409) { resolve(false); return; }
        if (response.statusCode !== 200) { reject(new Error(`Market authority returned ${response.statusCode}`)); return; }
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!value || typeof value !== "object" || !("valid" in value) || typeof value.valid !== "boolean") {
            throw new Error("Malformed market authority response");
          }
          resolve(value.valid);
        } catch (error) { reject(error); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error("Market authority verification timed out")), 5000);
    request.on("error", error => { clearTimeout(deadline); reject(error); });
    request.end(body);
  });
}
