import { randomBytes } from "crypto";

const LIVE_SEED_PATTERN = /^[a-f0-9]{64}$/;

export function createLiveSeed(): string {
  return randomBytes(32).toString("hex");
}

export function isPrivateLiveSeed(value: unknown): value is string {
  return typeof value === "string" && LIVE_SEED_PATTERN.test(value);
}
