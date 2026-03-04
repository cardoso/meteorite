import { Random } from 'meteor/random';

function randomToken(): string {
  return Random.hexString(20);
}

export type RandomSeed = string | (() => string);

export type RandomStreamOptions = {
  seed?: RandomSeed | RandomSeed[] | undefined;
};

export class RandomStream {
  public seed: string[];
  public sequences: Record<string, any> = Object.create(null);

  constructor(options: RandomStreamOptions = {}) {
    const { seed } = options;
    const rawSeedArray: RandomSeed[] = Array.isArray(seed)
      ? seed
      : [seed || randomToken()];

    this.seed = rawSeedArray.map((value) =>
      typeof value === "function" ? value() : value
    );
  }

  public _sequence(name: string): any {
    let sequence = this.sequences[name] || null;
    if (sequence === null) {
      const sequenceSeed = this.seed.concat(name);

      // Assuming Random.createWithSeeds exists on modern Random import
      this.sequences[name] = sequence = Random.createWithSeeds(...sequenceSeed);
    }
    return sequence;
  }

  public static get(scope?: { randomStream?: RandomStream, randomSeed?: string | string[] | undefined }, name?: string): any {
    if (!name) {
      name = "default";
    }
    if (!scope) {
      return Random.insecure || Random;
    }
    
    let randomStream = scope.randomStream;
    if (!randomStream) {
      scope.randomStream = randomStream = new RandomStream({
        seed: scope.randomSeed
      });
    }
    return randomStream._sequence(name);
  }
}

export function makeRpcSeed(enclosing: any, methodName: string): string {
  const stream = RandomStream.get(enclosing, `/rpc/${methodName}`);
  return stream.hexString(20);
}