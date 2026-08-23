import jwt from "jsonwebtoken";

export function buildSessionCookie(role?: "USER" | "ADMIN"): string[] {
  const token = jwt.sign(
    {
      id: "test-user-id",
      email: "test@example.com",
      ...(role ? { role } : {}),
    },
    process.env.JWT_KEY as string
  );
  const session = Buffer.from(JSON.stringify({ jwt: token })).toString("base64");

  return [`session=${session}`];
}
