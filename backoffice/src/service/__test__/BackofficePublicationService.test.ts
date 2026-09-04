import {
  EventStatus,
  EventVisibility,
  messengerWrapper,
} from "@betstan/common";
import NewEventPublisher from "../../event/publisher/NewEventPublisher";
import { Event } from "../../model/Event";
import { BackofficePublicationService } from "../BackofficePublicationService";

it("replays pending Backoffice publications with broker confirms", async () => {
  await Event.create([
    {
      eventId: "new-event",
      name: "New A - New B",
      time: new Date().toISOString(),
      home: "New A",
      away: "New B",
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.OFFLINE,
      newEventPublicationPending: true,
    },
    {
      eventId: "result-event",
      name: "Result A - Result B",
      time: new Date().toISOString(),
      home: "Result A",
      away: "Result B",
      homeResult: 2,
      awayResult: 1,
      status: EventStatus.RESULTED,
      visibility: EventVisibility.ONLINE,
      resultPublicationPending: true,
    },
    {
      eventId: "visibility-event",
      name: "Visibility A - Visibility B",
      time: new Date().toISOString(),
      home: "Visibility A",
      away: "Visibility B",
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.OFFLINE,
      visibilityPublicationPending: true,
      visibilityPublicationTarget: EventVisibility.OFFLINE,
    },
  ]);

  const service = new BackofficePublicationService(messengerWrapper.connection);
  await expect(service.replayPending()).resolves.toEqual(3);

  expect(NewEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(3);
  expect(NewEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledWith({
    data: expect.objectContaining({ id: "new-event" }),
  });
  expect(NewEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledWith({
    data: expect.objectContaining({
      eventId: "result-event",
      homeScore: 2,
      awayScore: 1,
    }),
  });
  expect(NewEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledWith({
    data: {
      eventId: "visibility-event",
      visibility: EventVisibility.OFFLINE,
    },
  });

  const events = await Event.find().select(
    "+newEventPublicationPending +resultPublicationPending "
    + "+visibilityPublicationPending +visibilityPublicationTarget"
  );
  for (const event of events) {
    expect(event.newEventPublicationPending).toBeUndefined();
    expect(event.resultPublicationPending).toBeUndefined();
    expect(event.visibilityPublicationPending).toBeUndefined();
    expect(event.visibilityPublicationTarget).toBeUndefined();
  }
});

it("leaves failed publications pending for a later replay", async () => {
  const publishWithConfirm =
    NewEventPublisher.prototype.publishWithConfirm as jest.Mock;
  const initConfirmChannel =
    NewEventPublisher.prototype.initConfirmChannel as jest.Mock;
  publishWithConfirm.mockRejectedValueOnce(new Error("confirm unavailable"));
  await Event.create({
    eventId: "pending-new-event",
    name: "Pending A - Pending B",
    time: new Date().toISOString(),
    home: "Pending A",
    away: "Pending B",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    newEventPublicationPending: true,
  });

  const service = new BackofficePublicationService(messengerWrapper.connection);
  await expect(service.replayPending()).resolves.toEqual(0);
  await expect(
    service.publishNewEventNow("pending-new-event")
  ).resolves.toEqual("PUBLISHED");

  const event = await Event.findOne({ eventId: "pending-new-event" }).select(
    "+newEventPublicationPending"
  );
  expect(event?.newEventPublicationPending).toBeUndefined();
  expect(initConfirmChannel).toHaveBeenCalledTimes(6);
});

it("treats absent pending markers as already published", async () => {
  const service = new BackofficePublicationService(messengerWrapper.connection);

  await expect(service.publishNewEventNow("missing")).resolves.toEqual(
    "PUBLISHED"
  );
  await expect(service.publishResultNow("missing")).resolves.toEqual(
    "PUBLISHED"
  );
  await expect(service.publishVisibilityNow("missing")).resolves.toEqual(
    "PUBLISHED"
  );
  expect(NewEventPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("keeps malformed pending result and visibility records for repair", async () => {
  await Event.create([
    {
      eventId: "missing-result",
      name: "Missing Result",
      time: new Date().toISOString(),
      home: "A",
      away: "B",
      status: EventStatus.RESULTED,
      visibility: EventVisibility.ONLINE,
      resultPublicationPending: true,
    },
    {
      eventId: "missing-visibility",
      name: "Missing Visibility",
      time: new Date().toISOString(),
      home: "C",
      away: "D",
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      visibilityPublicationPending: true,
    },
  ]);
  const service = new BackofficePublicationService(messengerWrapper.connection);

  await expect(service.publishResultNow("missing-result")).resolves.toEqual(
    "PENDING"
  );
  await expect(
    service.publishVisibilityNow("missing-visibility")
  ).resolves.toEqual("PENDING");
  expect(NewEventPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("times out an unconfirmed publication and leaves it pending", async () => {
  const publishWithConfirm =
    NewEventPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirm.mockImplementationOnce(() => new Promise(() => {}));
  await Event.create({
    eventId: "timed-out-event",
    name: "Timeout A - Timeout B",
    time: new Date().toISOString(),
    home: "Timeout A",
    away: "Timeout B",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    newEventPublicationPending: true,
  });
  const service = new BackofficePublicationService(
    messengerWrapper.connection,
    { confirmTimeoutMs: 5 }
  );

  await expect(service.publishNewEventNow("timed-out-event")).resolves.toEqual(
    "PENDING"
  );
  const event = await Event.findOne({ eventId: "timed-out-event" }).select(
    "+newEventPublicationPending"
  );
  expect(event?.newEventPublicationPending).toBe(true);
});

it("closes stale confirm channels before reinitializing after failure", async () => {
  const publishWithConfirm =
    NewEventPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirm.mockRejectedValueOnce(new Error("channel closed"));
  await Event.create({
    eventId: "closed-channel-event",
    name: "Closed A - Closed B",
    time: new Date().toISOString(),
    home: "Closed A",
    away: "Closed B",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    newEventPublicationPending: true,
  });
  const service = new BackofficePublicationService(messengerWrapper.connection);
  const closeChannels = [jest.fn(), jest.fn(), jest.fn()];
  [
    "newEventPublisher",
    "resultSetPublisher",
    "eventVisibilityPublisher",
  ].forEach((property, index) => {
    Reflect.set(
      Reflect.get(service, property) as object,
      "_confirmChannel",
      { close: closeChannels[index] }
    );
  });

  await expect(
    service.publishNewEventNow("closed-channel-event")
  ).resolves.toEqual("PENDING");

  for (const closeChannel of closeChannels) {
    expect(closeChannel).toHaveBeenCalledTimes(1);
  }
});

it("can retry initialization and start and stop its replay loop safely", async () => {
  const initConfirmChannel =
    NewEventPublisher.prototype.initConfirmChannel as jest.Mock;
  initConfirmChannel.mockRejectedValueOnce(new Error("channel unavailable"));
  const service = new BackofficePublicationService(
    messengerWrapper.connection,
    { pollIntervalMs: 5 }
  );

  await expect(service.init()).rejects.toThrow("channel unavailable");
  await expect(service.start()).resolves.toBeUndefined();
  await expect(service.start()).resolves.toBeUndefined();
  await expect(service.stop()).resolves.toBeUndefined();
  await expect(service.stop()).resolves.toBeUndefined();
});

it("keeps scheduling replay when confirm setup fails during startup", async () => {
  jest.useFakeTimers();
  const initConfirmChannel =
    NewEventPublisher.prototype.initConfirmChannel as jest.Mock;
  initConfirmChannel.mockRejectedValueOnce(new Error("channel unavailable"));
  const service = new BackofficePublicationService(
    messengerWrapper.connection,
    { pollIntervalMs: 5 }
  );

  await expect(service.start()).resolves.toBeUndefined();
  expect(initConfirmChannel).toHaveBeenCalledTimes(3);

  await jest.advanceTimersByTimeAsync(5);
  expect(initConfirmChannel).toHaveBeenCalledTimes(6);

  await service.stop();
  jest.useRealTimers();
});
