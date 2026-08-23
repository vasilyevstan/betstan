import jwt from "jsonwebtoken";

type TestSessionPayload = {
  id: string;
  email: string;
  role?: "USER" | "ADMIN";
  timestamp: Date | string;
};

export const buildSessionCookie = (
  payload: TestSessionPayload
): string[] => {
  const token = jwt.sign(payload, process.env.JWT_KEY!);
  const session = Buffer.from(JSON.stringify({ jwt: token })).toString(
    "base64"
  );

  return [`session=${encodeURIComponent(session)}`];
};
