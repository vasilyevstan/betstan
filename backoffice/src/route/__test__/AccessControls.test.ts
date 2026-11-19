import { AddressInfo } from "net";
import http, { Server } from "http";
import request from "supertest";
import { app } from "../../app";

let server: Server;
let upstream: jest.Mock;
let received: string[];
beforeEach(async () => {
  received = [];
  upstream = jest.fn((req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      received.push(body);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ registrationEnabled: true, loginEnabled: false, revision: 3 }));
    });
  });
  server = http.createServer((req, res) => upstream(req, res));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  delete process.env.AUTH_SERVICE_URL;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

it("reads the switches from Auth's internal listener with no-store", async () => {
  const response = await request(app).get("/api/backoffice/access-controls").expect(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(upstream.mock.calls[0][0].url).toBe("/internal/access-controls");
  expect(response.body).toEqual({ registrationEnabled: true, loginEnabled: false, revision: 3 });
});

it("forwards only the two boolean fields for a known switch", async () => {
  await request(app).put("/api/backoffice/access-controls/login")
    .send({ enabled: true, expectedEnabled: false, role: "ADMIN" }).expect(200);
  expect(upstream.mock.calls[0][0].method).toBe("PUT");
  expect(upstream.mock.calls[0][0].url).toBe("/internal/access-controls/login");
  expect(JSON.parse(received[0])).toEqual({ enabled: true, expectedEnabled: false });
});

it.each([
  ["an unknown switch", "/api/backoffice/access-controls/betting", { enabled: false, expectedEnabled: true }, 404],
  ["a traversal attempt", "/api/backoffice/access-controls/..%2Flogin", { enabled: false, expectedEnabled: true }, 404],
  ["a non-boolean body", "/api/backoffice/access-controls/registration", { enabled: "no", expectedEnabled: true }, 400],
])("rejects %s without calling Auth", async (_label, path, body, status) => {
  await request(app).put(path).send(body).expect(status);
  expect(upstream).not.toHaveBeenCalled();
});

it("preserves conflicts and hides unexpected Auth responses", async () => {
  upstream.mockImplementation((_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.statusCode = 409; res.end(JSON.stringify({ code: "CONFLICT", message: "Refresh" }));
  });
  expect((await request(app).put("/api/backoffice/access-controls/registration")
    .send({ enabled: false, expectedEnabled: true }).expect(409)).body.code).toBe("CONFLICT");

  upstream.mockImplementation((_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.statusCode = 500; res.end(JSON.stringify({ code: "BOOM", message: "internal detail" }));
  });
  expect((await request(app).get("/api/backoffice/access-controls").expect(503)).body).toEqual({
    code: "ACCESS_CONTROLS_UNAVAILABLE", message: "Access controls are unavailable",
  });
});

it("reports unavailable when Auth is not configured", async () => {
  delete process.env.AUTH_SERVICE_URL;
  await request(app).get("/api/backoffice/access-controls").expect(503);
});
