import request from "supertest";
import { app } from "../../app";

it("keeps serving requests after repeated unknown routes", async () => {
  const unknownRoutes = [
    "/api/event/__missing_route_one__",
    "/api/event/__missing_route_two__",
    "/api/event/__missing_route_three__",
  ];

  for (const route of unknownRoutes) {
    await request(app)
      .get(route)
      .expect(400)
      .expect({ errors: [{ msg: "" }] });
  }

  await request(app).get("/api/event").expect(200);
});
