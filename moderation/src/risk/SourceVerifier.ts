import http from "http";
import https from "https";
import { IModerationAffectedRow, ModerationDeclineReason } from "@betstan/common";
import { builtinMarketId } from "./BuiltinMarkets";

export interface RiskSourceCheck { kickoffAt: string; affectedRows: IModerationAffectedRow[]; marketTypes?: string[] }

export async function readEventAuthority(path: string): Promise<unknown> {
  const configured = process.env.EVENT_SERVICE_URL;
  if (!configured) throw new Error("Event authority is unavailable");
  if (!path.startsWith("/api/event/")) throw new Error("Invalid Event authority path");
  const url = new URL(path, configured);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid Event authority");
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(url, response => {
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { request.destroy(new Error("Event authority response too large")); return; }
        chunks.push(Buffer.from(chunk));
      });
      response.on("error", reject);
      response.on("end", () => {
        clearTimeout(deadline);
        if ([404, 409].includes(response.statusCode ?? 0)) { resolve(null); return; }
        if (response.statusCode !== 200) { reject(new Error("Event authority unavailable")); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("Invalid Event authority response")); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error("Event authority timed out")), 5000);
    request.on("error", error => { clearTimeout(deadline); reject(error); });
  });
}

/** Current public visibility and exact ordinary-price authority from Event's
 * existing per-event catalogue. This is a bounded evidence cut, not a remote
 * market lock or globally linearizable source-to-admission protocol.
 */
export async function verifyRiskSource(eventId: string, rows: any[], now = new Date(), requireMarketTypes = false): Promise<RiskSourceCheck> {
  const catalogue: any = await readEventAuthority(`/api/event/events/${encodeURIComponent(eventId)}/markets`);
  if (catalogue === null) throw new Error("Event authority unavailable");
  if (!catalogue?.event || catalogue.event.eventId !== eventId
    || !["ONLINE", "OFFLINE"].includes(catalogue.event.visibility)
    || !["NO_RESULT", "RESULTED"].includes(catalogue.event.status)
    || !Number.isFinite(Date.parse(catalogue.event.time))) throw new Error("Incomplete Event authority");
  const affectedRows: IModerationAffectedRow[] = [];
  const result: RiskSourceCheck = {
    kickoffAt: catalogue.event.time, affectedRows, ...(requireMarketTypes ? { marketTypes: [] } : {}),
  };
  if (catalogue.event.visibility !== "ONLINE" || catalogue.event.status !== "NO_RESULT") {
    affectedRows.push(...rows.map(row => ({ rowId: row.id, declineReason: catalogue.event.status === "RESULTED"
      ? ModerationDeclineReason.EVENT_RESULTED : ModerationDeclineReason.RISK_POLICY })));
    return result;
  }
  for (const row of rows) {
    if (requireMarketTypes && row.betKind !== "LIVE") {
      const productIds = row.marketBet
        ? row.marketBet.selections.filter((selection: any) => selection.origin === "STANDARD").map((selection: any) => selection.marketId)
        : [row.productId];
      for (const productId of productIds) {
        if (!Array.isArray(catalogue.standardMarkets)) throw new Error("Built-in market authority unavailable");
        const matches = catalogue.standardMarkets.filter((product: any) => product.marketId === productId);
        const id = matches.length === 1 ? builtinMarketId("PRE_MATCH", matches[0].marketType) : undefined;
        if (!id) throw new Error("Incomplete built-in market type authority");
        result.marketTypes!.push(id);
      }
    }
    if (row.betKind === "LIVE" && catalogue.event.liveEnabled === false) {
      affectedRows.push({ rowId: row.id, declineReason: ModerationDeclineReason.RISK_POLICY });
      continue;
    }
    if (row.betKind === "LIVE" || row.marketBet) continue;
    if (now.getTime() >= Date.parse(catalogue.event.time)) {
      affectedRows.push({ rowId: row.id, declineReason: ModerationDeclineReason.EVENT_STARTED });
      continue;
    }
    if (!Array.isArray(catalogue.standardSelections) || !catalogue.standardSelections.length) {
      throw new Error("Ordinary price authority unavailable");
    }
    const exact = catalogue.standardSelections.filter((s: any) => s.origin === "STANDARD" && s.marketId === row.productId && s.outcomeKey === row.oddsId);
    if (exact.length !== 1 || !Number.isFinite(exact[0].odds)) throw new Error("Incomplete ordinary selection authority");
    if (exact[0].odds !== row.oddsValue) affectedRows.push({
      rowId: row.id, declineReason: ModerationDeclineReason.STALE_QUOTE, currentOdds: exact[0].odds,
    });
  }
  if (result.marketTypes) result.marketTypes = [...new Set(result.marketTypes)].sort();
  return result;
}
