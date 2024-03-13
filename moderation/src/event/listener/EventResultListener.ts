import { ConsumeMessage } from "amqplib";
import { AListener, IEventResultEvent, QueueNames } from "@betstan/common";
import { Resulted } from "../../model/Resulted";

class EventResultListener extends AListener<IEventResultEvent> {
  serviceName: string = "moderation_event_result";
  queue: QueueNames.EVENT_RESULT = QueueNames.EVENT_RESULT;

  async onMessage(event: IEventResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    const resulted = new Resulted({
      eventId: data.eventId,
      timestamp: new Date().toISOString(),
    });

    await resulted.save();

    this.ack(msg);
  }
}

export default EventResultListener;
