import { ConsumeMessage } from "amqplib";
import { AListener, ILiveEventUpdateEvent, QueueNames } from "@betstan/common";
import { applyLiveEventUpdate } from "../../live/LiveEventReadModel";

class LiveEventProjectionListener extends AListener<ILiveEventUpdateEvent> {
  serviceName: string = "event_live_projection";
  queue: QueueNames.LIVE_EVENT_UPDATE = QueueNames.LIVE_EVENT_UPDATE;

  async onMessage(event: ILiveEventUpdateEvent, msg: ConsumeMessage) {
    await applyLiveEventUpdate(event);
    this.ack(msg);
  }
}

export default LiveEventProjectionListener;
