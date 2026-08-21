import type {
  Connection,
  ConsumeMessage,
} from "amqplib";
import {
  AListener,
  APublisher,
  IAmqpConnection,
  IEvent,
  QueueNames,
} from "../../build";

declare const legacyConnection: Connection;

const compatibleConnection: IAmqpConnection = legacyConnection;

class LegacyTypedListener extends AListener<IEvent> {
  queue = QueueNames.NEW_EVENT;
  serviceName = "legacy-typed-listener";

  onMessage(_event: IEvent, _message: ConsumeMessage): void {}
}

class LegacyTypedPublisher extends APublisher<IEvent> {
  queue = QueueNames.NEW_EVENT;
  serviceName = "legacy-typed-publisher";
}

new LegacyTypedListener(legacyConnection);
new LegacyTypedPublisher(legacyConnection);
void compatibleConnection;
