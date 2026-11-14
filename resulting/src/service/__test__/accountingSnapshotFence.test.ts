import { EventEmitter } from "events";
import { request as httpRequest } from "http";
import { queueState } from "../accountingSnapshotFence";

jest.mock("http", () => ({ ...jest.requireActual("http"), request: jest.fn() }));

it("ends a slow-drip response at the absolute 10s deadline even though data renews socket idle time", async () => {
  jest.useFakeTimers();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleDuration = 0;
  let idleCallback: (() => void) | undefined;
  const renewSocketIdleTime = () => {
    clearTimeout(idleTimer);
    if (idleDuration && idleCallback) idleTimer = setTimeout(idleCallback, idleDuration);
  };
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  const request: EventEmitter & { end: jest.Mock; destroy: jest.Mock; setTimeout: jest.Mock } = Object.assign(new EventEmitter(), {
    end: jest.fn(),
    destroy: jest.fn(() => {
      clearTimeout(idleTimer);
      request.emit("error", new Error("Underlying transport error must not escape"));
      return request;
    }),
    setTimeout: jest.fn((duration: number, callback?: () => void) => {
      idleDuration = duration;
      idleCallback = callback;
      renewSocketIdleTime();
      return request;
    }),
  });
  (httpRequest as jest.Mock).mockImplementation((_url, _options, onResponse) => {
    onResponse(response);
    return request;
  });
  try {
    const outcome = queueState(new URL("http://localhost/api/queues/test/test"))
      .then(() => { throw new Error("Unexpected successful incomplete response"); }, error => error);
    // Model real socket activity: each byte renews the idle timer but must not
    // renew the request deadline. Nine bytes also stay far below the body bound.
    for (let second = 1; second <= 9; second++) {
      jest.advanceTimersByTime(1000);
      expect(request.destroy).not.toHaveBeenCalled();
      response.emit("data", Buffer.from(" "));
      renewSocketIdleTime();
    }
    jest.advanceTimersByTime(999);
    expect(request.destroy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect((await outcome).message).toBe("Queue evidence timed out");
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
