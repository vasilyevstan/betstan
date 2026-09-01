import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventPhase,
  EventStatus,
  EventVisibility,
  IEventResultEvent,
  QueueNames,
} from "@betstan/common";

import { Event } from "../../model/Event";
import {
  buildHasOfflineIntentExpression,
  buildHasUnresolvedVisibilityAuthorityExpression,
} from "../../model/visibilityAuthorityExpressions";

const buildResultedAt = (timestamp: string | undefined): Date => {
  const resultedAt = timestamp ? new Date(timestamp) : new Date();
  return Number.isNaN(resultedAt.getTime()) ? new Date() : resultedAt;
};

const buildResultUpdatePipeline = (resultedAt: Date) => [
  {
    $set: {
      status: EventStatus.RESULTED,
      visibility: {
        $let: {
          vars: {
            isFullTime: { $eq: ["$live.phase", EventPhase.FULL_TIME] },
            isRetired: {
              $ne: [{ $ifNull: ["$liveRetiredAt", null] }, null],
            },
            hasOfflineIntent: buildHasOfflineIntentExpression(),
            hasUnresolvedVisibilityAuthority:
              buildHasUnresolvedVisibilityAuthorityExpression(),
          },
          in: {
            $cond: [
              {
                $and: [
                  "$$isFullTime",
                  { $eq: ["$$isRetired", false] },
                  { $eq: ["$$hasOfflineIntent", false] },
                  {
                    $eq: [
                      "$$hasUnresolvedVisibilityAuthority",
                      false,
                    ],
                  },
                ],
              },
              EventVisibility.ONLINE,
              EventVisibility.OFFLINE,
            ],
          },
        },
      },
      liveRaceResultedAt: {
        $let: {
          vars: {
            isFullTime: { $eq: ["$live.phase", EventPhase.FULL_TIME] },
            isRetired: {
              $ne: [{ $ifNull: ["$liveRetiredAt", null] }, null],
            },
            hasOfflineIntent: buildHasOfflineIntentExpression(),
          },
          in: {
            $cond: [
              {
                $or: [
                  "$$isFullTime",
                  "$$isRetired",
                  "$$hasOfflineIntent",
                ],
              },
              null,
              resultedAt,
            ],
          },
        },
      },
    },
  },
];

class EventResultListener extends AListener<IEventResultEvent> {
  serviceName: string = "event_result";
  queue: QueueNames.EVENT_RESULT = QueueNames.EVENT_RESULT;

  async onMessage(event: IEventResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    const storedEvent = await Event.findOne({ eventId: data.eventId })
      .select({ _id: 1 })
      .lean();

    if (!storedEvent) {
      console.log("event not found", event);
      this.channel.ack(msg);
      return;
    }

    await Event.updateOne(
      { eventId: data.eventId },
      buildResultUpdatePipeline(buildResultedAt(event.timestamp))
    );
    this.channel.ack(msg);
  }
}

export default EventResultListener;
