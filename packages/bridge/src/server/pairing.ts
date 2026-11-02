import type { Role } from "@herdr-mobile/protocol";
import type { Clock } from "../prototype/deadline.ts";
import { systemClock } from "../prototype/deadline.ts";

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const CODE_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_WRONG_ATTEMPTS = 5;
const ACCEPTED_RANDOM_BYTE_LIMIT = 256 - (256 % CODE_ALPHABET.length);

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export interface PairingGrant {
  role: Role;
  name?: string;
}

function makeCode(): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    const randomBytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH - code.length));
    for (const byte of randomBytes) {
      if (byte < ACCEPTED_RANDOM_BYTE_LIMIT) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code;
}

/** Holds one expiring, single-use pairing code and its failed-attempt budget. */
export class PairingCodes {
  private readonly clock: Clock;
  private current:
    | {
        code: string;
        expiresAt: number;
        role: Role;
        name?: string;
        wrongAttempts: number;
      }
    | undefined;

  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  issue(role: Role, name?: string): PairingCode {
    const code = makeCode();
    const expiresAt = this.clock.now() + CODE_LIFETIME_MS;
    this.current = {
      code,
      expiresAt,
      role,
      ...(name === undefined ? {} : { name }),
      wrongAttempts: 0,
    };
    return { code, expiresAt };
  }

  redeem(code: string): PairingGrant | undefined {
    const current = this.current;
    if (!current) return undefined;
    if (this.clock.now() >= current.expiresAt) {
      this.current = undefined;
      return undefined;
    }
    if (code === current.code) {
      this.current = undefined;
      return {
        role: current.role,
        ...(current.name === undefined ? {} : { name: current.name }),
      };
    }

    current.wrongAttempts += 1;
    if (current.wrongAttempts >= MAX_WRONG_ATTEMPTS) this.current = undefined;
    return undefined;
  }
}
