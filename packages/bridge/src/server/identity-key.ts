import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { x25519 } from "@noble/curves/ed25519.js";
import type { Clock } from "../prototype/deadline.ts";
import type { StoreFs } from "./devices.ts";

const IDENTITY_FILE_MODE = 0o600;
const IDENTITY_FILENAME = "identity.json";
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface IdentityKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface IdentityKeyStore {
  current(): IdentityKeyPair;
  rotate(): Promise<IdentityKeyPair>;
  onRotate(listener: (keyPair: IdentityKeyPair) => void): () => void;
}

/** The real filesystem adapter used by the identity key store. */
export const nodeIdentityKeyFs: StoreFs = {
  async readFile(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  async writeFile(path, contents, options) {
    await writeFile(path, contents, options);
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async unlink(path) {
    try {
      await unlink(path);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
  },
};

/** Loads or creates the bridge's persistent X25519 identity key. */
export async function openIdentityKey(
  path: string,
  fs: StoreFs,
  _clock: Clock,
): Promise<IdentityKeyStore> {
  if (basename(path) !== IDENTITY_FILENAME) {
    throw new Error("identity key file must be identity.json inside the bridge state directory");
  }

  let keyPair: IdentityKeyPair;
  let contents: string | undefined;
  try {
    contents = await fs.readFile(path);
  } catch (error) {
    throw new Error(`${path}: unable to read identity key file: ${errorReason(error)}`);
  }

  if (contents === undefined) {
    keyPair = generateKeyPair();
    await writeIdentity(fs, path, keyPair);
  } else {
    try {
      keyPair = parseKeyPair(contents);
    } catch (error) {
      throw new Error(`${path}: invalid identity key file: ${errorReason(error)}`);
    }
  }

  return new StoredIdentityKey(path, fs, keyPair);
}

/** Encode a public identity key for a pair link, status reply or CLI display. */
export function encodePublicKey(key: Uint8Array): string {
  return Buffer.from(key).toString("base64url");
}

function generateKeyPair(): IdentityKeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secretKey);
  return { publicKey, secretKey };
}

function parseKeyPair(contents: string): IdentityKeyPair {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("identity file is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("identity file has the wrong shape");
  }
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.publicKey !== "string" ||
    typeof record.secretKey !== "string"
  ) {
    throw new Error("identity file has the wrong shape");
  }
  const publicKey = decodeKey(record.publicKey);
  const secretKey = decodeKey(record.secretKey);
  if (publicKey.byteLength !== 32 || secretKey.byteLength !== 32) {
    throw new Error("identity keys must be 32 bytes");
  }
  const expectedPublicKey = x25519.getPublicKey(secretKey);
  if (!equalBytes(publicKey, expectedPublicKey))
    throw new Error("identity key pair does not match");
  return { publicKey, secretKey };
}

function decodeKey(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) throw new Error("invalid base64url key");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("invalid base64url key");
  return new Uint8Array(bytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index++) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

async function writeIdentity(fs: StoreFs, path: string, keyPair: IdentityKeyPair): Promise<void> {
  const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
  const contents = JSON.stringify({
    v: 1,
    publicKey: encodePublicKey(keyPair.publicKey),
    secretKey: encodePublicKey(keyPair.secretKey),
  });
  try {
    await fs.mkdir(dirname(path));
    await fs.writeFile(temporaryPath, contents, { mode: IDENTITY_FILE_MODE, flag: "wx" });
    await fs.rename(temporaryPath, path);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

class StoredIdentityKey implements IdentityKeyStore {
  private keyPair: IdentityKeyPair;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(keyPair: IdentityKeyPair) => void>();
  private readonly path: string;
  private readonly fs: StoreFs;

  constructor(path: string, fs: StoreFs, keyPair: IdentityKeyPair) {
    this.path = path;
    this.fs = fs;
    this.keyPair = keyPair;
  }

  current(): IdentityKeyPair {
    return cloneKeyPair(this.keyPair);
  }

  rotate(): Promise<IdentityKeyPair> {
    const next = this.writeTail
      .catch(() => {})
      .then(async () => {
        const keyPair = generateKeyPair();
        await writeIdentity(this.fs, this.path, keyPair);
        this.keyPair = keyPair;
        const snapshot = cloneKeyPair(keyPair);
        for (const listener of this.listeners) {
          try {
            listener(cloneKeyPair(snapshot));
          } catch {
            // Listener failures must not undo a persisted identity rotation.
          }
        }
        return snapshot;
      });
    this.writeTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  onRotate(listener: (keyPair: IdentityKeyPair) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function cloneKeyPair(keyPair: IdentityKeyPair): IdentityKeyPair {
  return { publicKey: keyPair.publicKey.slice(), secretKey: keyPair.secretKey.slice() };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160) || "unknown error";
}
