import { BadRequestError } from "@betstan/common";
import { errorHandler } from "../../middleware/ErrorHandler";

const flushPromises = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe("coverage entrypoints", () => {
  const originalEnv = process.env;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.exitCode = originalExitCode;
  });

  afterEach(() => {
    process.env = originalEnv;
    process.exitCode = originalExitCode;
    jest.restoreAllMocks();
  });

  it("serializes common and ordinary errors through the error middleware", () => {
    const send = jest.fn();
    const status = jest.fn(() => ({ send }));

    Reflect.apply(errorHandler, null, [
      new BadRequestError("invalid"),
      {},
      { status },
      jest.fn(),
    ]);
    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({ errors: [{ msg: "invalid" }] });

    status.mockClear();
    send.mockClear();
    Reflect.apply(errorHandler, null, [
      new Error("ordinary"),
      {},
      { status },
      jest.fn(),
    ]);
    expect(status).toHaveBeenCalledWith(400);
    expect(send).toHaveBeenCalledWith({ errors: "ordinary" });
  });

  it("runs the fixed role update command and disconnects cleanly", async () => {
    const connect = jest.fn().mockResolvedValue(undefined);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 1 });
    const isValidObjectId = jest.fn().mockReturnValue(true);
    const log = jest.spyOn(console, "log").mockImplementation(() => {});

    process.env.MONGO_URI = "mongodb://example.invalid/auth";
    process.env.USER_ID = "0123456789abcdef01234567";
    process.env.USER_ROLE = "ADMIN";
    process.env.USER_ROLE_CHANGE_CONFIRMATION =
      "SET_ROLE:0123456789abcdef01234567:ADMIN";

    jest.doMock("mongoose", () => ({
      __esModule: true,
      default: { connect, disconnect, isValidObjectId },
    }));
    jest.doMock("../../model/User", () => ({
      User: { updateOne },
      UserRole: { USER: "USER", ADMIN: "ADMIN" },
    }));

    jest.isolateModules(() => {
      require("../../scripts/SetUserRole");
    });
    await flushPromises();

    expect(connect).toHaveBeenCalledWith("mongodb://example.invalid/auth");
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "0123456789abcdef01234567" },
      { $set: { role: "ADMIN" } },
    );
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "Updated role for user 0123456789abcdef01234567",
    );
  });

  it("fails closed when a required role-update value is missing", async () => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    delete process.env.MONGO_URI;
    process.env.USER_ID = "0123456789abcdef01234567";
    process.env.USER_ROLE = "USER";
    process.env.USER_ROLE_CHANGE_CONFIRMATION =
      "SET_ROLE:0123456789abcdef01234567:USER";

    jest.doMock("mongoose", () => ({
      __esModule: true,
      default: {
        connect: jest.fn(),
        disconnect,
        isValidObjectId: jest.fn(),
      },
    }));
    jest.doMock("../../model/User", () => ({
      User: { updateOne: jest.fn() },
      UserRole: { USER: "USER", ADMIN: "ADMIN" },
    }));

    jest.isolateModules(() => {
      require("../../scripts/SetUserRole");
    });
    await flushPromises();

    expect(error).toHaveBeenCalledWith("MONGO_URI must be set");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("rejects invalid role changes before reporting a missing user", async () => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue(undefined);
    const updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 });
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    process.env.MONGO_URI = "mongodb://example.invalid/auth";
    process.env.USER_ID = "invalid-id";
    process.env.USER_ROLE = "USER";
    process.env.USER_ROLE_CHANGE_CONFIRMATION = "SET_ROLE:invalid-id:USER";

    const loadScript = (validObjectId: boolean) => {
      jest.doMock("mongoose", () => ({
        __esModule: true,
        default: {
          connect,
          disconnect,
          isValidObjectId: jest.fn().mockReturnValue(validObjectId),
        },
      }));
      jest.doMock("../../model/User", () => ({
        User: { updateOne },
        UserRole: { USER: "USER", ADMIN: "ADMIN" },
      }));
      jest.isolateModules(() => {
        require("../../scripts/SetUserRole");
      });
    };

    loadScript(false);
    await flushPromises();
    expect(error).toHaveBeenLastCalledWith(
      "USER_ID must be a valid MongoDB object ID",
    );

    jest.resetModules();
    process.env.USER_ID = "0123456789abcdef01234567";
    process.env.USER_ROLE = "OWNER";
    process.env.USER_ROLE_CHANGE_CONFIRMATION =
      "SET_ROLE:0123456789abcdef01234567:OWNER";
    loadScript(true);
    await flushPromises();
    expect(error).toHaveBeenLastCalledWith("USER_ROLE must be USER or ADMIN");

    jest.resetModules();
    process.env.USER_ROLE = "USER";
    process.env.USER_ROLE_CHANGE_CONFIRMATION = "wrong";
    loadScript(true);
    await flushPromises();
    expect(error).toHaveBeenLastCalledWith(
      "USER_ROLE_CHANGE_CONFIRMATION does not match the requested change",
    );

    jest.resetModules();
    process.env.USER_ROLE_CHANGE_CONFIRMATION =
      "SET_ROLE:0123456789abcdef01234567:USER";
    loadScript(true);
    await flushPromises();
    expect(error).toHaveBeenLastCalledWith("User was not found");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it("runs deletion and reports a non-Error rejection without exposing it", async () => {
    const connect = jest.fn().mockResolvedValue(undefined);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const deleteUserById = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce("private failure");
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    process.env.MONGO_URI = "mongodb://example.invalid/auth";
    process.env.USER_ID = "0123456789abcdef01234567";
    process.env.USER_EMAIL = "user@example.invalid";
    process.env.USER_DELETE_CONFIRMATION =
      "DELETE_USER:0123456789abcdef01234567:user@example.invalid";

    const loadScript = () => {
      jest.doMock("mongoose", () => ({
        __esModule: true,
        default: { connect, disconnect },
      }));
      jest.doMock("../../service/DeleteUser", () => ({ deleteUserById }));
      jest.isolateModules(() => {
        require("../../scripts/DeleteUser");
      });
    };

    loadScript();
    await flushPromises();
    expect(deleteUserById).toHaveBeenCalledWith(
      "0123456789abcdef01234567",
      "user@example.invalid",
      "DELETE_USER:0123456789abcdef01234567:user@example.invalid",
    );
    expect(log).toHaveBeenCalledWith(
      "Deleted user 0123456789abcdef01234567",
    );

    jest.resetModules();
    loadScript();
    await flushPromises();
    expect(error).toHaveBeenCalledWith("User deletion failed");
    expect(process.exitCode).toBe(1);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
