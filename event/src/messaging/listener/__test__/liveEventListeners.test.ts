import { liveEventHub } from "../../../live/LiveEventHub";
import { createLiveEventListeners } from "../liveEventListeners";

it("uses the shared hub when no listener options are provided", () => {
  const registry = createLiveEventListeners({} as any);

  expect((registry.fanoutListener as any).hub).toBe(liveEventHub);
  expect((registry.fanoutListener as any).podId).toBeUndefined();
});
