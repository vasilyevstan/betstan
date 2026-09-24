const INTERNAL_EVENT_FIELDS = [
  "cashBackGeneration",
  "cashBackAuthorityRevision",
  "cashBackAuthorityAt",
  "cashBackFenceAt",
  "cashBackHold",
  "creationRequestId",
  "creationRequestFingerprint",
  "newEventPublicationPending",
  "resultPublicationPending",
  "visibilityPublicationPending",
  "visibilityPublicationTarget",
] as const;

interface SerializableEvent {
  toObject(): Record<string, unknown>;
}

export const serializeBackofficeEvent = (event: SerializableEvent) => {
  const serializedEvent = event.toObject();
  for (const field of INTERNAL_EVENT_FIELDS) {
    delete serializedEvent[field];
  }
  return serializedEvent;
};
