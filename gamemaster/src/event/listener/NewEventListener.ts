import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventPhase,
  EventStatus,
  INewEventEvent,
  QueueNames,
} from "@betstan/common";
import { Event } from "../../model/Event";
import { EventArchive } from "../../model/EventArchive";
import { createLiveSeed } from "../../simulation/liveSeed";

class NewEventListener extends AListener<INewEventEvent> {
  serviceName: string = "gamemaster_new_event";
  queue: QueueNames.NEW_EVENT = QueueNames.NEW_EVENT;

  async onMessage(event: INewEventEvent, msg: ConsumeMessage) {
    const { data } = event;

    if (await EventArchive.exists({ eventId: data.id })) {
      this.ack(msg);
      return;
    }

    try {
      await Event.updateOne(
        { eventId: data.id },
        {
          $setOnInsert: {
            eventId: data.id,
            name: data.name,
            time: new Date(data.time),
            home: data.home,
            away: data.away,
            status: EventStatus.NO_RESULT,
            phase: EventPhase.PRE_MATCH,
            liveSeed: createLiveSeed(),
          },
        },
        { upsert: true }
      );
    } catch (err: any) {
      if (err?.code !== 11000) {
        throw err;
      }
    }

    this.ack(msg);
  }
}

export default NewEventListener;
