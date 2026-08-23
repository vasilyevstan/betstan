import http from "http";
import { AddressInfo } from "net";
import { verifyAdminSession } from "../VerifyAdminSession";

let server: http.Server | undefined;

afterEach(async () => {
  delete process.env.AUTH_SERVICE_URL;
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
});

async function startAuthStub(status: number) {
  let receivedCookie: string | undefined;
  server = http.createServer((request, response) => {
    receivedCookie = request.headers.cookie;
    response.statusCode = status;
    response.end();
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${address.port}`;

  return () => receivedCookie;
}

it.each([204, 401, 403] as const)(
  "returns the supported auth verification status %s",
  async (status) => {
    const receivedCookie = await startAuthStub(status);

    await expect(verifyAdminSession("session=signed")).resolves.toBe(status);
    expect(receivedCookie()).toBe("session=signed");
  }
);

it("rejects an unexpected auth response", async () => {
  await startAuthStub(500);

  await expect(verifyAdminSession("session=signed")).rejects.toThrow(
    "Unexpected auth verification status 500"
  );
});

it("rejects a missing or unsupported auth service URL", async () => {
  await expect(verifyAdminSession("session=signed")).rejects.toThrow(
    "AUTH_SERVICE_URL is not configured"
  );

  process.env.AUTH_SERVICE_URL = "file:///tmp/auth";
  await expect(verifyAdminSession("session=signed")).rejects.toThrow(
    "AUTH_SERVICE_URL must use HTTP or HTTPS"
  );
});
