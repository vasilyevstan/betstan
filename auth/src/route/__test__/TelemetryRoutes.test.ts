import request from "supertest";
import { app } from "../../app";
import { User } from "../../model/User";
import { authTelemetryReporter } from "../../service/TelemetryReporter";

it("reports account creation only after successful persistence", async () => {
  const report = jest.spyOn(authTelemetryReporter, "report");
  await request(app)
    .post("/api/auth/new")
    .send({ email: "telemetry-user", password: "password" })
    .expect(201);
  expect(report).toHaveBeenCalledWith("USER_CREATED");

  report.mockClear();
  await request(app)
    .post("/api/auth/new")
    .send({ email: "telemetry-user", password: "password" })
    .expect(400);
  expect(report).not.toHaveBeenCalled();
});

it("reports login only after accepted credentials and successful save", async () => {
  await User.create({
    email: "login-telemetry",
    identifierNormalized: "login-telemetry",
    password: "password",
  });
  const report = jest.spyOn(authTelemetryReporter, "report");

  const response = await request(app)
    .post("/api/auth/login")
    .send({ email: "login-telemetry", password: "password" })
    .expect(200);
  expect(report).toHaveBeenCalledWith("USER_LOGGED_IN");
  expect(response.body).toEqual({
    id: expect.any(String),
    email: "login-telemetry",
    role: "USER",
  });

  report.mockClear();
  await request(app)
    .post("/api/auth/login")
    .send({ email: "login-telemetry", password: "wrong" })
    .expect(400);
  expect(report).not.toHaveBeenCalled();
});
