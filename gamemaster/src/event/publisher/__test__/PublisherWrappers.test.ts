import {
  APublisher,
  ILiveEventUpdateEvent,
  IEventResultEvent,
  QueueNames,
} from "@betstan/common";

import LiveEventUpdatePublisher from "../LiveEventUpdatePublisher";
import ResultSetPublisher from "../ResultSetPublisher";

describe("publisher wrappers", () => {
  it("delegates result publishing helpers to APublisher", async () => {
    const initSpy = jest
      .spyOn(APublisher.prototype as any, "init")
      .mockResolvedValue(undefined);
    const initConfirmSpy = jest
      .spyOn(APublisher.prototype as any, "initConfirmChannel")
      .mockResolvedValue(undefined);
    const publishSpy = jest
      .spyOn(APublisher.prototype as any, "publishWithConfirm")
      .mockResolvedValue(undefined);
    const publisher = new ResultSetPublisher({} as any);

    await publisher.init();
    await publisher.initConfirmChannel();
    await publisher.publishWithConfirm({
      data: {
        eventId: "result-event",
        homeScore: 1,
        awayScore: 0,
        home: "Home",
        away: "Away",
      },
    } as IEventResultEvent);

    expect(publisher.queue).toBe(QueueNames.EVENT_RESULT);
    expect(publisher.serviceName).toBe("gamemaster_result_set");
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initConfirmSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it("delegates live update publishing helpers to APublisher", async () => {
    const initSpy = jest
      .spyOn(APublisher.prototype as any, "init")
      .mockResolvedValue(undefined);
    const initConfirmSpy = jest
      .spyOn(APublisher.prototype as any, "initConfirmChannel")
      .mockResolvedValue(undefined);
    const publishSpy = jest
      .spyOn(APublisher.prototype as any, "publishWithConfirm")
      .mockResolvedValue(undefined);
    const publisher = new LiveEventUpdatePublisher({} as any);

    await publisher.init();
    await publisher.initConfirmChannel();
    await publisher.publishWithConfirm({
      data: {
        eventId: "live-event",
        sequence: 1,
        occurredAt: new Date("2025-01-01T12:00:00.000Z").toISOString(),
        kickoffAt: new Date("2025-01-01T12:00:00.000Z").toISOString(),
        minute: 0,
        phase: "PRE_MATCH",
        homeScore: 0,
        awayScore: 0,
        bettingStatus: "OPEN",
        markets: [],
        settlements: [],
      },
    } as unknown as ILiveEventUpdateEvent);

    expect(publisher.queue).toBe(QueueNames.LIVE_EVENT_UPDATE);
    expect(publisher.serviceName).toBe("gamemaster_live_event_update");
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initConfirmSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });
});
