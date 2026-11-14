import { createHash } from "crypto";

export const cashBackHash = (value: unknown): string => {
  const stable = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input) ?? "null";
    if (Array.isArray(input)) return `[${input.map(stable).join(",")}]`;
    return `{${Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  };
  return createHash("sha256").update(stable(value)).digest("hex");
};
