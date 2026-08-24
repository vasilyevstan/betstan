import {
  BetKind,
  EventPhase,
  LiveMarketType,
  LiveSettlementReason,
  ResultingStatus,
  TeamSide,
  messengerWrapper,
} from "@betstan/common";
import LiveEventUpdateListener from "../../event/listener/LiveEventUpdateListener";
import { Bet, BetArchive } from "../../model/Bet";
import SettleSlipPublisher from "../../event/publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../../event/publisher/SettleSlipRowPublisher";
import { TerminalSettlementSweepWorker } from "../terminalSettlementSweep";
import { reconcileSlip } from "../resulting";
import {
  createBet,
  createLiveMarketSnapshot,
  createLiveRow,
  createLiveSettlement,
  createLiveUpdateEvent,
  createMessage,
  setupPublisherSpies,
} from "../../test/resultingTestUtils";

setupPublisherSpies();

const createLiveListener = async () => {
  const listener = new LiveEventUpdateListener(messengerWrapper.connection);
  await listener.init();
  return listener;
};

const createSweepWorker = async () => {
  const worker = new TerminalSettlementSweepWorker(messengerWrapper.connection);
  await worker.init();
  return worker;
};

const manualVoidEventForRow = (row: any) => {
  const settlement = createLiveSettlement({
    eventId: row.eventId,
    marketId: row.marketId,
    marketType: row.marketType,
    marketVersion: row.marketVersion,
    settlementReason: LiveSettlementReason.MANUAL_VOID,
    winningSide: TeamSide.NONE,
    winningSelection: row.selectionId,
    settlementSequence: 7,
  });

  return createLiveUpdateEvent({
    eventId: row.eventId,
    sequence: settlement.settlementSequence,
    occurredAt: "2026-08-20T17:00:00.000Z",
    phase:
      row.marketType === LiveMarketType.HALF_TIME_RESULT
        ? EventPhase.HALF_TIME
        : EventPhase.SECOND_HALF,
    homeScore: 1,
    awayScore: 1,
    markets: [
      createLiveMarketSnapshot({
        eventId: row.eventId,
        marketId: row.marketId,
        marketType: row.marketType,
        marketVersion: row.marketVersion,
      }),
    ],
    settlements: [settlement],
  });
};

it(
  "recovers a manual-void terminal settlement after an injected terminal "
    + "publish failure without double publishing",
  async () => {
    const firstRow = createLiveRow({ marketType: LiveMarketType.NEXT_PENALTY });
    const secondRow = createLiveRow({
      marketType: LiveMarketType.HALF_TIME_RESULT,
      side: TeamSide.DRAW,
    });
    const bet = await createBet({
      betKind: BetKind.LIVE,
      rows: [firstRow, secondRow],
      status: ResultingStatus.BET_APPROVED,
    });

    const publishWithConfirm =
      SettleSlipPublisher.prototype.publishWithConfirm as jest.Mock;
    publishWithConfirm
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValue(undefined);

    const listener = await createLiveListener();

    // First leg voided: the bet still has one unresolved row, so no terminal
    // publish is attempted yet.
    await listener.onMessage(manualVoidEventForRow(firstRow), createMessage());

    // Second leg voided: the bet becomes fully void, rows are published and
    // removed, and the terminal settle-slip publish is attempted - and
    // fails (injected failure).
    await listener.onMessage(manualVoidEventForRow(secondRow), createMessage());

    expect(publishWithConfirm).toHaveBeenCalledTimes(1);

    const stuckBet = await Bet.findOne({ slipId: bet.slipId });
    expect(stuckBet).not.toBeNull();
    expect(stuckBet!.status).toEqual(ResultingStatus.BET_VOID);
    expect(stuckBet!.terminalPublicationState).toEqual("PENDING");
    expect(stuckBet!.rows).toHaveLength(0);
    expect(await BetArchive.findOne({ slipId: bet.slipId })).toBeNull();

    // Nothing will ever touch this slipId again through the normal live
    // update path (its rows were already removed), so only the independent
    // sweep can recover it - simulating a restart/replay.
    const sweepWorker = await createSweepWorker();
    const processedOnRecovery = await sweepWorker.runOnce();

    expect(processedOnRecovery).toEqual(1);
    expect(publishWithConfirm).toHaveBeenCalledTimes(2);

    const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
    expect(archivedBet).not.toBeNull();
    expect(archivedBet!.status).toEqual(ResultingStatus.BET_VOID);
    expect(archivedBet!.terminalPublicationState).toEqual("PUBLISHED");
    expect(archivedBet!.rows).toHaveLength(0);
    expect(await Bet.findOne({ slipId: bet.slipId })).toBeNull();

    // A subsequent sweep pass must be a pure no-op: already archived slips
    // must never be re-published.
    const processedAfterRecovery = await sweepWorker.runOnce();
    expect(processedAfterRecovery).toEqual(0);
    expect(publishWithConfirm).toHaveBeenCalledTimes(2);
  }
);

it(
  "reclaims a stale terminal-publish claim left behind by a crash and "
    + "completes exactly once",
  async () => {
    const bet = await createBet({
      betKind: BetKind.LIVE,
      rows: [],
      status: ResultingStatus.BET_VOID,
    });

    const staleClaimedAt = new Date(Date.now() - 60_000);
    await Bet.updateOne(
      { _id: bet._id },
      {
        $set: {
          terminalPublicationState: "PUBLISHING",
          terminalPublicationClaimedAt: staleClaimedAt,
        },
      }
    );

    const publishWithConfirm =
      SettleSlipPublisher.prototype.publishWithConfirm as jest.Mock;
    publishWithConfirm.mockResolvedValue(undefined);

    const sweepWorker = await createSweepWorker();
    const processed = await sweepWorker.runOnce();

    expect(processed).toEqual(1);
    expect(publishWithConfirm).toHaveBeenCalledTimes(1);

    const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
    expect(archivedBet).not.toBeNull();
    expect(archivedBet!.terminalPublicationState).toEqual("PUBLISHED");
    expect(await Bet.findOne({ slipId: bet.slipId })).toBeNull();
  }
);

it("archives a published terminal bet left active by a crash", async () => {
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [],
    status: ResultingStatus.BET_VOID,
  });
  await Bet.updateOne(
    { _id: bet._id },
    {
      $set: {
        terminalPublicationState: "PUBLISHED",
      },
    }
  );
  const publishWithConfirm =
    SettleSlipPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirm.mockResolvedValue(undefined);

  const sweepWorker = await createSweepWorker();
  const processed = await sweepWorker.runOnce();

  expect(processed).toEqual(1);
  expect(publishWithConfirm).not.toHaveBeenCalled();
  expect(await Bet.findOne({ slipId: bet.slipId })).toBeNull();
  expect(
    (await BetArchive.findOne({ slipId: bet.slipId }))
      ?.terminalPublicationState
  ).toEqual("PUBLISHED");
});

it("claims and publishes a legacy terminal bet with no publication state", async () => {
  const bet = await createBet({
    betKind: BetKind.PRE_MATCH,
    rows: [],
    status: ResultingStatus.BET_WIN,
  });
  await Bet.collection.updateOne(
    { _id: bet._id },
    {
      $unset: {
        terminalPublicationState: "",
      },
    }
  );
  expect(
    (await Bet.collection.findOne(
      { _id: bet._id },
      { projection: { terminalPublicationState: 1 } }
    ))?.terminalPublicationState
  ).toBeUndefined();
  const publishWithConfirm =
    SettleSlipPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirm.mockResolvedValue(undefined);

  const sweepWorker = await createSweepWorker();
  const processed = await sweepWorker.runOnce();

  expect(processed).toEqual(1);
  expect(publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(await Bet.findOne({ slipId: bet.slipId })).toBeNull();
  expect(
    (await BetArchive.findOne({ slipId: bet.slipId }))
      ?.terminalPublicationState
  ).toEqual("PUBLISHED");
});

it("reclaims a terminal publishing state with no claim timestamp", async () => {
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [],
    status: ResultingStatus.BET_VOID,
  });
  await Bet.updateOne(
    { _id: bet._id },
    {
      $set: {
        terminalPublicationState: "PUBLISHING",
        terminalPublicationClaimId: "legacy-claim",
      },
      $unset: {
        terminalPublicationClaimedAt: "",
      },
    }
  );
  const publishWithConfirm =
    SettleSlipPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirm.mockResolvedValue(undefined);

  const sweepWorker = await createSweepWorker();
  const processed = await sweepWorker.runOnce();

  expect(processed).toEqual(1);
  expect(publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(await Bet.findOne({ slipId: bet.slipId })).toBeNull();
  expect(
    (await BetArchive.findOne({ slipId: bet.slipId }))
      ?.terminalPublicationState
  ).toEqual("PUBLISHED");
});

it("recovers an approved all-void slip after its last row was removed", async () => {
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [],
    status: ResultingStatus.BET_APPROVED,
  });
  const publishWithConfirm =
    SettleSlipPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirm.mockResolvedValue(undefined);

  const sweepWorker = await createSweepWorker();
  const processed = await sweepWorker.runOnce();

  expect(processed).toEqual(1);
  expect(publishWithConfirm).toHaveBeenCalledTimes(1);
  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_VOID);
  expect(archivedBet!.rows).toHaveLength(0);
  expect(await Bet.findOne({ slipId: bet.slipId })).toBeNull();
});

it(
  "does not reclaim an active (non-stale) terminal-publish claim",
  async () => {
    const bet = await createBet({
      betKind: BetKind.LIVE,
      rows: [],
      status: ResultingStatus.BET_VOID,
    });

    await Bet.updateOne(
      { _id: bet._id },
      {
        $set: {
          terminalPublicationState: "PUBLISHING",
          terminalPublicationClaimedAt: new Date(),
        },
      }
    );

    const publishWithConfirm =
      SettleSlipPublisher.prototype.publishWithConfirm as jest.Mock;
    publishWithConfirm.mockResolvedValue(undefined);

    const sweepWorker = await createSweepWorker();
    const processed = await sweepWorker.runOnce();

    // Active claims are omitted until they become stale, so they cannot
    // monopolize a bounded sweep batch.
    expect(processed).toEqual(0);
    expect(publishWithConfirm).not.toHaveBeenCalled();

    const untouchedBet = await Bet.findOne({ slipId: bet.slipId });
    expect(untouchedBet).not.toBeNull();
    expect(untouchedBet!.terminalPublicationState).toEqual("PUBLISHING");
    expect(await BetArchive.findOne({ slipId: bet.slipId })).toBeNull();
  }
);

it("does not let a stale publisher release a replacement claim", async () => {
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [],
    status: ResultingStatus.BET_VOID,
  });
  let rejectPublish: ((error: Error) => void) | undefined;
  const publishWithConfirm =
    SettleSlipPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirm.mockImplementationOnce(
    () => new Promise<void>((_resolve, reject) => {
      rejectPublish = reject;
    })
  );
  const publishers = {
    settleSlipPublisher: new SettleSlipPublisher(messengerWrapper.connection),
    settleSlipRowPublisher: new SettleSlipRowPublisher(
      messengerWrapper.connection
    ),
  };

  const reconciliation = reconcileSlip(bet.slipId, publishers);
  while (!rejectPublish) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const claimedBet = await Bet.findOne({ slipId: bet.slipId });
  expect(claimedBet!.terminalPublicationClaimId).toEqual(expect.any(String));

  await Bet.updateOne(
    {
      _id: bet._id,
      terminalPublicationClaimId: claimedBet!.terminalPublicationClaimId,
    },
    {
      $set: {
        terminalPublicationState: "PUBLISHING",
        terminalPublicationClaimedAt: new Date(),
        terminalPublicationClaimId: "replacement-claim",
      },
    }
  );

  rejectPublish!(new Error("stale publisher failed"));
  await expect(reconciliation).rejects.toThrow("stale publisher failed");

  const replacementClaim = await Bet.findOne({ slipId: bet.slipId });
  expect(replacementClaim!.terminalPublicationState).toEqual("PUBLISHING");
  expect(replacementClaim!.terminalPublicationClaimId).toEqual(
    "replacement-claim"
  );
});

it("does not let a stale publisher confirm a replacement claim", async () => {
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [],
    status: ResultingStatus.BET_VOID,
  });
  let resolvePublish: (() => void) | undefined;
  const publishWithConfirm =
    SettleSlipPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirm.mockImplementationOnce(
    () => new Promise<void>((resolve) => {
      resolvePublish = resolve;
    })
  );
  const publishers = {
    settleSlipPublisher: new SettleSlipPublisher(messengerWrapper.connection),
    settleSlipRowPublisher: new SettleSlipRowPublisher(
      messengerWrapper.connection
    ),
  };

  const reconciliation = reconcileSlip(bet.slipId, publishers);
  while (!resolvePublish) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const claimedBet = await Bet.findOne({ slipId: bet.slipId });
  await Bet.updateOne(
    {
      _id: bet._id,
      terminalPublicationClaimId: claimedBet!.terminalPublicationClaimId,
    },
    {
      $set: {
        terminalPublicationState: "PUBLISHING",
        terminalPublicationClaimedAt: new Date(),
        terminalPublicationClaimId: "replacement-claim",
      },
    }
  );

  resolvePublish!();
  await reconciliation;

  const replacementClaim = await Bet.findOne({ slipId: bet.slipId });
  expect(replacementClaim!.terminalPublicationState).toEqual("PUBLISHING");
  expect(replacementClaim!.terminalPublicationClaimId).toEqual(
    "replacement-claim"
  );
  expect(await BetArchive.findOne({ slipId: bet.slipId })).toBeNull();
});
