import { createHash } from "crypto";

export const MAX_POISSON_LAMBDA = 200;

export interface NamedRng {
  readonly stream: string;
  uniform(): number;
  integer(min: number, max: number): number;
}

function block(seed: string | number, stream: string, counter: number): Buffer {
  return createHash("sha256")
    .update(`${String(seed)}\u0000${stream}\u0000${counter}`)
    .digest();
}

export function createNamedRng(seed: string | number, stream: string): NamedRng {
  let counter = 0;
  return {
    stream,
    uniform(): number {
      const bytes = block(seed, stream, counter++);
      const high = bytes.readUInt32BE(0) & 0x1fffff;
      const low = bytes.readUInt32BE(4);
      return (high * 0x100000000 + low) / 0x20000000000000;
    },
    integer(min: number, max: number): number {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError("integer bounds are invalid");
      }
      return min + Math.floor(this.uniform() * (max - min + 1));
    },
  };
}

export function samplePoisson(lambda: number, uniform: number): number {
  if (
    !Number.isFinite(lambda)
    || lambda < 0
    || lambda > MAX_POISSON_LAMBDA
  ) {
    throw new RangeError(
      `lambda must be between 0 and ${MAX_POISSON_LAMBDA}`
    );
  }
  if (!Number.isFinite(uniform) || uniform < 0 || uniform >= 1) {
    throw new RangeError("uniform must be in [0, 1)");
  }
  if (lambda === 0) {
    return 0;
  }

  let probability = Math.exp(-lambda);
  let cumulative = probability;
  let result = 0;
  while (uniform > cumulative) {
    result += 1;
    const nextProbability = probability * lambda / result;
    const nextCumulative = cumulative + nextProbability;
    if (nextCumulative === cumulative) {
      return result;
    }
    probability = nextProbability;
    cumulative = nextCumulative;
  }
  return result;
}
