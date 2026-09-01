import { EventVisibility } from "@betstan/common";

type MongoExpression = Record<string, unknown>;

export const buildHasOfflineIntentExpression = (): MongoExpression => ({
  $or: [
    { $eq: ["$visibilityDecision", EventVisibility.OFFLINE] },
    { $eq: ["$pendingVisibility", EventVisibility.OFFLINE] },
    {
      $and: [
        {
          $eq: [{ $ifNull: ["$visibilityDecision", null] }, null],
        },
        {
          $eq: [{ $ifNull: ["$pendingVisibility", null] }, null],
        },
        { $eq: ["$visibilityInitialized", true] },
        { $eq: ["$visibility", EventVisibility.OFFLINE] },
      ],
    },
  ],
});

export const buildHasUnresolvedVisibilityAuthorityExpression =
  (): MongoExpression => ({
    $or: [
      { $eq: ["$visibilityInitialized", false] },
      { $eq: ["$eventMetadataInitialized", false] },
      {
        $and: [
          {
            $eq: [{ $ifNull: ["$eventMetadataInitialized", null] }, null],
          },
          { $eq: ["$source", "EXTERNAL"] },
          {
            $ne: [{ $ifNull: ["$live.sequence", null] }, null],
          },
          {
            $eq: [{ $size: { $ifNull: ["$products", []] } }, 0],
          },
        ],
      },
    ],
  });
