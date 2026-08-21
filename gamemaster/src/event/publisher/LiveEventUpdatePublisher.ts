import {
  APublisher,
  ILiveEventUpdateEvent,
  QueueNames,
} from "@betstan/common";

class LiveEventUpdatePublisher extends APublisher<ILiveEventUpdateEvent> {
  serviceName: string = "gamemaster_live_event_update";
  queue: QueueNames.LIVE_EVENT_UPDATE = QueueNames.LIVE_EVENT_UPDATE;

  async init(): Promise<void> {
    await super.init();
  }

  async initConfirmChannel(): Promise<void> {
    await super.initConfirmChannel();
  }

  async publishWithConfirm(data: ILiveEventUpdateEvent): Promise<void> {
    await super.publishWithConfirm(data);
  }
}

export default LiveEventUpdatePublisher;
