import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import { BetKind, IAmqpConnection, IModerationResultEvent, messengerWrapper, QueueNames } from "@betstan/common";
import { createPlaceBetEvent } from "../../event/listener/__test__/helpers";
import BetModerationResultPublisher from "../../event/publisher/BetModerationResultPublisher";
import { Bet } from "../../model/Bet";
import ModerationService from "../../service/ModerationService";
import { initializeRisk, mutatePolicy } from "../Store";

jest.unmock("@betstan/common");

// Hosted CI supplies Docker. Local opt-in requires an already-running daemon;
// this test never starts or changes a shared Docker installation.
const brokerTests = process.env.GITHUB_ACTIONS === "true" || process.env.RISK_TEST_BROKER === "true"
  ? describe : describe.skip;
const execute = promisify(execFile);
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

brokerTests("durable moderation publication with a real broker", () => {
  const name = `risk-recovery-${randomUUID()}`;
  const queue = `${name}-outcomes`;
  let creationAttempted = false;
  let connection: IAmqpConnection | undefined;
  let channel: Awaited<ReturnType<typeof messengerWrapper.getChannel>> | undefined;
  let publisher: BetModerationResultPublisher | undefined;
  const originalEnabled = process.env.RISK_CENTRE_ENABLED;
  const docker = (args: string[], timeout = 120000) =>
    execute("docker", args, { timeout, maxBuffer: 64 * 1024 });

  async function ready() {
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        await docker(["exec", name, "rabbitmq-diagnostics", "-q", "check_running"], 5000);
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await pause(500);
      }
    }
  }

  async function connect() {
    const binding = (await docker(["port", name, "5672/tcp"])).stdout.trim();
    if (!/^127\.0\.0\.1:[1-9][0-9]*$/.test(binding)) throw new Error("Unexpected test broker binding");
    await messengerWrapper.connect(`amqp://risk:test-only-password@${binding}`);
    connection = messengerWrapper.connection;
    channel = await messengerWrapper.getChannel();
    publisher = new BetModerationResultPublisher(connection);
    await publisher.init();
    await publisher.initConfirmChannel();
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, QueueNames.MODERATION_RESULT, "");
    return publisher;
  }

  async function disconnect() {
    await publisher?.close();
    publisher = undefined;
    await channel?.close();
    channel = undefined;
    await connection?.close();
    connection = undefined;
  }

  beforeAll(async () => {
    await docker(["info", "--format", "{{.ServerVersion}}"], 10000);
    creationAttempted = true;
    await docker([
      "create", "--name", name, "--publish", "127.0.0.1::5672",
      "--env", "RABBITMQ_DEFAULT_USER=risk", "--env", "RABBITMQ_DEFAULT_PASS=test-only-password",
      "rabbitmq:3.12.10-management",
    ]);
    await docker(["start", name]);
    await ready();
  }, 180000);

  afterAll(async () => {
    try {
      await disconnect();
    } finally {
      if (originalEnabled === undefined) delete process.env.RISK_CENTRE_ENABLED;
      else process.env.RISK_CENTRE_ENABLED = originalEnabled;
      if (creationAttempted) {
        try { await docker(["rm", "--force", "--volumes", name]); }
        catch (error) {
          if (!(error instanceof Error) || !("stderr" in error)
            || !String(error.stderr).includes(`No such container: ${name}`)) throw error;
        }
      }
    }
  }, 30000);

  it("preserves the confirmed message across broker restart and replays the same durable decision once", async () => {
    process.env.RISK_CENTRE_ENABLED = "true";
    await initializeRisk();
    await mutatePolicy("UPDATE", {
      expectedRevision: 1, requestId: "broker-deny",
      rule: { id: "default:DENY", type: "DENY", enabled: true, scope: {}, parameters: {} },
    }, "default:DENY");
    const input = createPlaceBetEvent({
      data: { betKind: BetKind.PRE_MATCH },
      row: { betKind: BetKind.PRE_MATCH, eventTime: new Date(Date.now() + 600000).toISOString() },
    });
    const firstPublisher = await connect();
    const interrupted = new ModerationService({
      publishWithConfirm: async (event: IModerationResultEvent) => {
        await firstPublisher.publishWithConfirm(event);
        throw new Error("Injected failure after broker confirm, before publication commit");
      },
    });
    await expect(interrupted.handlePlaceBet(input)).rejects.toThrow("Injected failure");
    const decision = await Bet.findOne({ slipId: input.data.slipId }).lean();
    expect(decision).toMatchObject({ publishedAt: "", declineReason: "RISK_POLICY" });

    await disconnect();
    await docker(["stop", "--time", "10", name]);
    await docker(["start", name]);
    await ready();
    const recoveredPublisher = await connect();
    const retained = await channel!.get(queue, { noAck: false });
    if (!retained) throw new Error("Confirmed persistent decision did not survive broker restart");
    const original: IModerationResultEvent = JSON.parse(retained.content.toString("utf8"));
    expect(original.data).toMatchObject({
      slipId: input.data.slipId, decisionId: `moderation:${input.data.slipId}`,
      occurredAt: decision!.moderationTimestamp, policyRevision: 2, reasonCodes: ["RISK_DENY"],
    });
    channel!.ack(retained);

    const recovered = new ModerationService(recoveredPublisher);
    expect(await recovered.recoverDecisionsAndReceipts()).toBe(1);
    const replay = await channel!.get(queue, { noAck: false });
    if (!replay) throw new Error("Durable publication obligation was not recovered");
    const repeated: IModerationResultEvent = JSON.parse(replay.content.toString("utf8"));
    expect(repeated.data).toEqual(original.data);
    channel!.ack(replay);
    expect((await Bet.findOne({ slipId: input.data.slipId }).lean())?.publishedAt).not.toBe("");
    expect(await recovered.recoverDecisionsAndReceipts()).toBe(0);
    expect(await channel!.get(queue, { noAck: false })).toBe(false);
  }, 180000);
});
