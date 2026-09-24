import { ChildProcess, fork } from "child_process";
import { resolve } from "path";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import http from "http";
import type { CashBackQuote, CashBackReceipt } from "@betstan/common";

if (process.env.CASH_BACK_INTEGRATION !== "1") throw new Error("Real cash-back integration must be explicitly enabled");
const mongoBase = process.env.CASH_BACK_TEST_MONGO_BASE;
const broker = process.env.CASH_BACK_TEST_RABBIT_URI;
if (
  !mongoBase || !/^mongodb:\/\/127\.0\.0\.1:\d+$/.test(mongoBase)
  || !broker || !/^amqp:\/\/cashback_test:cashback_test@127\.0\.0\.1:\d+$/.test(broker)
) throw new Error("Isolated loopback Mongo/RabbitMQ endpoints are required");

jest.setTimeout(60_000);
const root = resolve(__dirname, "../../..");
const run = randomUUID().replace(/-/g, "");
const children: ChildProcess[] = [];
let requestId = 0;
interface Actor {
  child: ChildProcess;
  port?: number;
  command(action: string, data?: Record<string, unknown>): Promise<unknown>;
  paused(): Promise<void>;
}
const startActor = async (role: string): Promise<Actor> => {
  const child = fork(resolve(__dirname, "cashBackTransportProcess.ts"), [], {
    cwd: resolve(root, role),
    execArgv: ["-r", resolve(root, role, "node_modules/ts-node/register/transpile-only")],
    env: {
      ...process.env, NODE_ENV: "test", JWT_KEY: "cashback-isolated-test",
      CASH_BACK_TEST_ROLE: role,
      CASH_BACK_TEST_MONGO_URI: `${mongoBase}/cashback_it_${run}_${role}`,
      CASH_BACK_TEST_RABBIT_URI: broker,
      TS_NODE_PROJECT: resolve(root, role, "tsconfig.json"),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let pauseResolve: (() => void) | undefined;
  let pauseObserved = false;
  const ready = new Promise<number | undefined>((resolveReady, reject) => {
    child.on("message", (message: { type: string; id: number; port?: number; result?: unknown; error?: string }) => {
      if (message.type === "ready") resolveReady(message.port);
      if (message.type === "paused") { pauseObserved = true; pauseResolve?.(); }
      if (message.type === "response") {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error));
        else waiter?.resolve(message.result);
      }
    });
    child.on("exit", code => {
      const error = new Error(`${role} exited ${code}: ${stderr}`);
      reject(error);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
  });
  const port = await ready;
  return {
    child, port,
    command: (action, data) => new Promise((resolveCommand, reject) => {
      if (action.startsWith("pause-")) { pauseObserved = false; pauseResolve = undefined; }
      const id = ++requestId;
      pending.set(id, { resolve: resolveCommand, reject });
      child.send({ id, action, data });
    }),
    paused: () => pauseObserved ? Promise.resolve() : new Promise<void>(resolvePause => { pauseResolve = resolvePause; }),
  };
};

const token = jwt.sign({
  id: "owner", email: "owner@example.test", role: "USER", timestamp: new Date().toISOString(),
}, "cashback-isolated-test");
const cookie = `session=${Buffer.from(JSON.stringify({ jwt: token })).toString("base64")}`;
interface Reply {
  status: number;
  body: {
    operationId?: string;
    clientOperationId?: string;
    state?: string;
    quote?: CashBackQuote;
    receipt?: CashBackReceipt;
    items?: CashBackReceipt[];
  };
}
interface OfferedOperation { operationId: string; clientOperationId: string; quote: CashBackQuote }
const api = (actor: Actor, path: string, body?: unknown, authenticated = true): Promise<Reply> =>
  new Promise((resolveReply, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port: actor.port, path, method: text ? "POST" : "GET",
      headers: {
        ...(authenticated ? { Cookie: cookie } : {}),
        ...(text ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) } : {}),
      },
    }, res => {
      let response = "";
      res.on("data", chunk => { response += chunk.toString(); });
      res.on("end", () => resolveReply({ status: res.statusCode!, body: response ? JSON.parse(response) : {} }));
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error("Isolated HTTP request timed out")));
    req.end(text);
  });

const until = async <T>(read: () => Promise<T>, matches: (value: T) => boolean, timeout = 20_000): Promise<T> => {
  const deadline = Date.now() + timeout;
  let latest: T;
  do {
    latest = await read();
    if (matches(latest)) return latest;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  } while (Date.now() < deadline);
  throw new Error(`Isolated cash-back condition timed out: ${JSON.stringify(latest)}`);
};

let bo: Actor;
let gm: Actor;
let resulting: Actor;
let resultingPeer: Actor;
let bet: Actor;
beforeAll(async () => {
  [bo, gm, resulting, bet] = await Promise.all([
    startActor("backoffice"), startActor("gamemaster"), startActor("resulting"), startActor("bet"),
  ]);
  resultingPeer = await startActor("resulting");
});
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
    await exited;
    clearTimeout(timer);
  }
});

const seed = async (live = false) => {
  const eventId = randomUUID();
  const slipId = randomUUID();
  const time = new Date(Date.now() + (live ? -60_000 : 60_000)).toISOString();
  const marketId = `${eventId}:NEXT_CORNER`;
  const selectionId = `${marketId}:1:HOME`;
  const quoteValidUntil = new Date(Date.now() + 30_000).toISOString();
  const event = { eventId, name: "A - B", time, home: "A", away: "B", status: "NO_RESULT", phase: live ? "FIRST_HALF" : "PRE_MATCH" };
  await Promise.all([
    bo.command("seed-event", event),
    gm.command("seed-event", {
      ...event,
      ...(live ? {
        liveSequence: 1, liveConfirmedReplayCursor: 1,
        cashBackAuthoritySnapshot: {
          eventId, sequence: 1, occurredAt: new Date().toISOString(), kickoffAt: time, minute: 10,
          phase: "FIRST_HALF", bettingStatus: "OPEN", homeScore: 0, awayScore: 0,
          markets: [{
            marketId, marketType: "NEXT_CORNER", marketVersion: 1, quoteVersion: 2,
            quoteValidUntil, status: "OPEN", selections: [{ selectionId, side: "HOME", odds: 6 }],
          }],
          settlements: [],
        },
      } : {}),
    }),
  ]);
  await resulting.command("place", {
    userId: "owner", userName: "Owner", slipId, wager: 100, betKind: live ? "LIVE" : "PRE_MATCH",
    rows: [{
      id: "row", eventId, eventName: "A - B", eventTime: time, oddsId: "home", oddsValue: 3,
      oddsName: "A", productId: live ? marketId : "1x2", productName: live ? "Next Corner" : "1X2",
      timestamp: new Date().toISOString(), betKind: live ? "LIVE" : "PRE_MATCH",
      ...(live ? { marketId, marketType: "NEXT_CORNER", marketVersion: 1, quoteVersion: 1,
        selectionId, side: "HOME", selectedAt: new Date().toISOString(), quoteValidUntil } : {}),
    }],
  });
  await until(() => bet.command("bet-state", { slipId }), value =>
    Boolean(value && typeof value === "object" && "status" in value && value.status === "CONFIRMED"));
  await until(() => resulting.command("bet-state", { slipId }), value =>
    Boolean(value && typeof value === "object" && "status" in value && value.status === "BET_APPROVED"));
  return { eventId, slipId };
};
const offer = async (slipId: string, clientOperationId: string, stakeMinor?: number) => {
  const initial = await api(bet, `/api/bet/${slipId}/cash-back/quote`, {
    action: "QUOTE", clientOperationId,
    portion: stakeMinor === undefined ? { mode: "FULL" } : { mode: "PARTIAL", stakeMinor },
  });
  expect(initial.status).toBe(202);
  const ready = await until(
    () => api(bet, `/api/bet/${slipId}/cash-back/operations/${initial.body.operationId}`),
    value => value.body.state !== "QUOTE_PENDING"
  );
  expect(ready.body.state).toBe("QUOTED");
  if (!ready.body.operationId || !ready.body.clientOperationId || !ready.body.quote) {
    throw new Error("Missing public quote binding");
  }
  return {
    operationId: ready.body.operationId, clientOperationId: ready.body.clientOperationId, quote: ready.body.quote,
  };
};
const confirm = async (slipId: string, operation: OfferedOperation) => {
  const response = await api(bet, `/api/bet/${slipId}/cash-back/accept`, {
    action: "CONFIRM", clientOperationId: operation.clientOperationId, quoteId: operation.quote.quoteId,
  });
  expect([200, 202]).toContain(response.status);
  return until(
    () => api(bet, `/api/bet/${slipId}/cash-back/operations/${operation.operationId}`),
    value => typeof value.body.state === "string" && ["ACCEPTED", "REJECTED", "UNAVAILABLE"].includes(value.body.state)
  );
};

it("runs repeated partial/full HTTP flows through real RabbitMQ and two independent Resulting workers", async () => {
  const fixture = await seed();
  for (const [id, stake] of [["partial-one", 4000], ["partial-two", 1000], ["full", undefined]] as const) {
    const quoted = await offer(fixture.slipId, id, stake);
    const accepted = await confirm(fixture.slipId, quoted);
    expect(accepted.body.state).toBe("ACCEPTED");
    if (accepted.body.receipt?.outcome !== "ACCEPTED") throw new Error("Missing canonical acceptance");
    expect(Date.parse(accepted.body.receipt.decisionTime)).toBeLessThan(Date.parse(quoted.quote.expiresAt));
    await until(() => resulting.command("bet-state", { slipId: fixture.slipId }), value =>
      Boolean(value && typeof value === "object" && "financial" in value && value.financial));
    for (const source of [bo, gm]) await until(() => source.command("event-state", fixture), value =>
      Boolean(value && typeof value === "object" && "held" in value && value.held === false));
  }
  const projected = await until(() => bet.command("bet-state", fixture), value =>
    Boolean(value && typeof value === "object" && "status" in value && value.status === "CASH_BACK"));
  expect(projected).toMatchObject({
    wager: 100, financial: { remainingStakeMinor: 0, cumulativeClosedStakeMinor: 10000, cumulativeReturnMinor: 10000 },
  });
  const history = await api(bet, `/api/bet/${fixture.slipId}/cash-back/history`);
  expect(history.body.items).toHaveLength(3);
});

it("keeps the winning random quote ID across two paused producer processes, retries and late confirmation recovery", async () => {
  const fixture = await seed();
  const quoteRequest = {
    action: "QUOTE", clientOperationId: "quote-identity-race", portion: { mode: "PARTIAL", stakeMinor: 1000 },
  };
  await Promise.all([
    resulting.command("pause-quote", { clientOperationId: quoteRequest.clientOperationId }),
    resultingPeer.command("pause-quote", { clientOperationId: quoteRequest.clientOperationId }),
  ]);
  try {
    const initial = await api(bet, `/api/bet/${fixture.slipId}/cash-back/quote`, quoteRequest);
    expect(initial.status).toBe(202);
    await Promise.all([resulting.paused(), resultingPeer.paused()]);
    const statusPath = `/api/bet/${fixture.slipId}/cash-back/operations/${initial.body.operationId}`;
    expect((await api(bet, statusPath)).body.state).toBe("QUOTE_PENDING");
    await resultingPeer.command("resume");
    const winner = await until(() => api(bet, statusPath), value => value.body.state === "QUOTED");
    if (!winner.body.operationId || !winner.body.clientOperationId || !winner.body.quote) {
      throw new Error("Missing persisted winning quote");
    }
    const operation = {
      operationId: winner.body.operationId, clientOperationId: winner.body.clientOperationId, quote: winner.body.quote,
    };
    expect(operation.quote.quoteId).toMatch(/^[a-f0-9]{64}$/);
    await resulting.command("resume");
    const retries = await Promise.all([
      api(bet, `/api/bet/${fixture.slipId}/cash-back/quote`, quoteRequest),
      api(bet, `/api/bet/${fixture.slipId}/cash-back/quote`, quoteRequest),
    ]);
    expect(retries.map(reply => reply.body.quote)).toEqual([operation.quote, operation.quote]);
    const confirmed = await confirm(fixture.slipId, operation);
    expect(confirmed.body.state).toBe("ACCEPTED");
    await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, Date.parse(operation.quote.expiresAt) - Date.now()) + 25));
    const recovered = await confirm(fixture.slipId, operation);
    expect(recovered.body.receipt).toEqual(confirmed.body.receipt);
    expect(recovered.body.quote).toEqual(operation.quote);
    expect(await resulting.command("bet-state", fixture)).toMatchObject({
      financial: { remainingStakeMinor: 9000, cumulativeClosedStakeMinor: 1000 },
    });
  } finally {
    await Promise.all([resulting.command("resume"), resultingPeer.command("resume")]);
  }
});

it("rejects source-result-before-publication while downstream ledgers still lag", async () => {
  const fixture = await seed();
  const quoted = await offer(fixture.slipId, "source-race", 1000);
  await bo.command("pause-result", fixture);
  const resultRequest = api(bo, "/api/backoffice/result", { eventId: fixture.eventId, homeResult: 1, awayResult: 0 }, false);
  await bo.paused();
  try {
    const outcome = await confirm(fixture.slipId, quoted);
    expect(outcome.body.state).toBe("REJECTED");
    if (outcome.body.receipt?.outcome !== "REJECTED") throw new Error("Missing canonical rejection");
    expect(outcome.body.receipt.reason).toBe("SELECTION_RESOLVED");
    expect(outcome.body.receipt.financial.cumulativeClosedStakeMinor).toBe(0);
  } finally {
    await bo.command("resume");
    await resultRequest;
  }
});

it("prices and closes the exact live market instance through the same real service boundaries", async () => {
  const fixture = await seed(true);
  const partial = await offer(fixture.slipId, "live-partial", 4000);
  expect(partial.quote.acceptedCombinedOdds).toBe("3");
  expect(partial.quote.currentCombinedOdds).toBe("6");
  expect(partial.quote.returnMinor).toBe(2000);
  expect((await confirm(fixture.slipId, partial)).body.state).toBe("ACCEPTED");
  for (const source of [bo, gm]) await until(() => source.command("event-state", fixture), value =>
    Boolean(value && typeof value === "object" && "held" in value && value.held === false));
  const full = await offer(fixture.slipId, "live-full");
  expect(full.quote.closedStakeMinor).toBe(6000);
  expect(full.quote.returnMinor).toBe(3000);
  expect((await confirm(fixture.slipId, full)).body.state).toBe("ACCEPTED");
  expect(await until(() => bet.command("bet-state", fixture), value =>
    Boolean(value && typeof value === "object" && "status" in value && value.status === "CASH_BACK")))
    .toMatchObject({ financial: { cumulativeClosedStakeMinor: 10000, cumulativeReturnMinor: 5000 } });
});

it("recovers a lost grant ACK after worker death using the canonical expired decision", async () => {
  const fixture = await seed();
  const quoted = await offer(fixture.slipId, "lost-grant", 1000);
  await gm.command("pause-grant", { operationId: quoted.operationId });
  const confirming = confirm(fixture.slipId, quoted);
  await gm.paused();
  const held = await gm.command("event-state", fixture);
  expect(held).toMatchObject({ held: true, generation: 1 });
  const outcome = await confirming;
  expect(outcome.body.state).toBe("REJECTED");
  if (outcome.body.receipt?.outcome !== "REJECTED") throw new Error("Missing canonical expiry");
  expect(outcome.body.receipt.reason).toBe("QUOTE_EXPIRED");
  expect(await gm.command("event-state", fixture)).toMatchObject({ held: true, generation: 1 });
  const exited = new Promise<void>(resolveExit => gm.child.once("exit", () => resolveExit()));
  gm.child.kill("SIGKILL");
  await exited;
  gm = await startActor("gamemaster");
  await until(() => gm.command("event-state", fixture), value =>
    Boolean(value && typeof value === "object" && "held" in value && value.held === false));
  expect(await gm.command("event-state", fixture)).toMatchObject({ generation: 2 });
});

it("applies the actual Mongo decision predicates strictly at deadline -1, equality and +1ms", async () => {
  const rows = await resulting.command("deadline-matrix");
  expect(rows).toEqual([
    expect.objectContaining({ offset: -1, eligible: false, expired: true }),
    expect.objectContaining({ offset: 0, eligible: false, expired: true }),
    expect.objectContaining({ offset: 1, eligible: true, expired: false }),
  ]);
});

it("rejects while a real result consumer is paused after its ledger write and before Bet mutation", async () => {
  const fixture = await seed();
  const quoted = await offer(fixture.slipId, "ledger-gap", 1000);
  await Promise.all([
    resulting.command("pause-ledger", fixture),
    resultingPeer.command("pause-ledger", fixture),
  ]);
  await api(bo, "/api/backoffice/result", { eventId: fixture.eventId, homeResult: 1, awayResult: 0 }, false);
  await Promise.race([resulting.paused(), resultingPeer.paused()]);
  expect(await resulting.command("ledger-state", fixture)).toBe(true);
  expect(await resulting.command("bet-state", fixture)).toMatchObject({ status: "BET_APPROVED" });
  try {
    const outcome = await confirm(fixture.slipId, quoted);
    expect(outcome.body.state).toBe("REJECTED");
    if (outcome.body.receipt?.outcome !== "REJECTED") throw new Error("Missing result-first rejection");
    expect(outcome.body.receipt.reason).toBe("SELECTION_RESOLVED");
    expect(outcome.body.receipt.financial.cumulativeClosedStakeMinor).toBe(0);
  } finally {
    await Promise.all([resulting.command("resume"), resultingPeer.command("resume")]);
  }
});

it("makes competing independent acceptors read the one canonical expiry winner", async () => {
  const fixture = await seed();
  const quoted = await offer(fixture.slipId, "competing-expiry", 1000);
  await Promise.all([
    resulting.command("pause-decision", { operationId: quoted.operationId }),
    resultingPeer.command("pause-decision", { operationId: quoted.operationId }),
  ]);
  const confirming = confirm(fixture.slipId, quoted);
  await Promise.all([resulting.paused(), resultingPeer.paused()]);
  await new Promise(resolveWait => setTimeout(resolveWait, Math.max(0, Date.parse(quoted.quote.expiresAt) - Date.now()) + 25));
  await Promise.all([resulting.command("resume"), resultingPeer.command("resume")]);
  const outcome = await confirming;
  expect(outcome.body.state).toBe("REJECTED");
  if (outcome.body.receipt?.outcome !== "REJECTED") throw new Error("Missing canonical expiry receipt");
  expect(outcome.body.receipt.reason).toBe("QUOTE_EXPIRED");
  expect(Date.parse(outcome.body.receipt.decisionTime)).toBeGreaterThanOrEqual(Date.parse(quoted.quote.expiresAt));
  expect(await resulting.command("bet-state", fixture)).toMatchObject({
    financial: { remainingStakeMinor: 10000, cumulativeClosedStakeMinor: 0 },
  });
});

it("recovers the exact confirmed live intent after worker death before cursor persistence", async () => {
  const fixture = await seed();
  await gm.command("pause-after-live", fixture);
  const ticking = gm.command("tick").catch(error => {
    expect(error.message).toContain("gamemaster exited");
  });
  await gm.paused();
  const before = await gm.command("event-state", fixture);
  expect(before).toMatchObject({ intent: true, preKickoffPublished: false });
  const exited = new Promise<void>(resolveExit => gm.child.once("exit", () => resolveExit()));
  gm.child.kill("SIGKILL");
  await exited;
  await ticking;
  await new Promise(resolveWait => setTimeout(resolveWait, 200));
  gm = await startActor("gamemaster");
  await gm.command("tick");
  const after = await gm.command("event-state", fixture);
  if (!before || typeof before !== "object" || !("snapshotHash" in before)) throw new Error("Missing persisted intent evidence");
  expect(after).toMatchObject({
    intent: false, preKickoffPublished: true, snapshotHash: before.snapshotHash,
  });
});

it("never lets a losing old acceptor reject a newer operation after slot reuse", async () => {
  const fixture = await seed();
  const first = await offer(fixture.slipId, "slot-one", 1000);
  await Promise.all([
    resulting.command("pause-decision", { operationId: first.operationId }),
    resultingPeer.command("pause-decision", { operationId: first.operationId }),
  ]);
  const firstConfirmation = confirm(fixture.slipId, first);
  await Promise.all([resulting.paused(), resultingPeer.paused()]);
  await resultingPeer.command("resume");
  expect((await firstConfirmation).body.state).toBe("ACCEPTED");
  await until(() => resultingPeer.command("bet-state", fixture), value =>
    Boolean(value && typeof value === "object" && "pending" in value && value.pending === null));
  const second = await offer(fixture.slipId, "slot-two", 1000);
  await resultingPeer.command("pause-decision", { operationId: second.operationId });
  const secondConfirmation = confirm(fixture.slipId, second);
  await resultingPeer.paused();
  await resulting.command("pause-decision-after-resume", { operationId: second.operationId });
  await resulting.paused();
  expect(await resulting.command("bet-state", fixture)).toMatchObject({
    pending: { state: "UNDECIDED", operationId: second.operationId },
  });
  await Promise.all([resulting.command("resume"), resultingPeer.command("resume")]);
  expect((await secondConfirmation).body.state).toBe("ACCEPTED");
  expect(await resulting.command("bet-state", fixture)).toMatchObject({
    financial: { remainingStakeMinor: 8000, cumulativeClosedStakeMinor: 2000 },
  });
});
