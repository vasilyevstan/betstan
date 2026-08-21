import { messengerWrapper } from "@betstan/common";
import BetModerationResultPublisher from "../BetModerationResultPublisher";

it("closes confirm and regular channels when they were initialised", async () => {
  const publisher = new BetModerationResultPublisher(messengerWrapper.connection);
  const confirmChannel = {
    close: jest.fn(async () => undefined),
  };
  const channel = {
    close: jest.fn(async () => undefined),
  };

  Reflect.set(publisher, "_confirmChannel", confirmChannel);
  Reflect.set(publisher, "_channel", channel);

  await publisher.close();

  expect(confirmChannel.close).toHaveBeenCalledTimes(1);
  expect(channel.close).toHaveBeenCalledTimes(1);
});

it("keeps publisher close safe when channels were never initialised", async () => {
  const publisher = new BetModerationResultPublisher(messengerWrapper.connection);

  await expect(publisher.close()).resolves.toBeUndefined();
});
