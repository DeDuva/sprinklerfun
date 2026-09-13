import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// At-rest encryption for stored Flume secrets (client secret, refresh token,
// access token). AES-256-GCM with a key derived from APP_ENCRYPTION_KEY.
//
// When APP_ENCRYPTION_KEY is unset (local dev), encryption is a no-op and values
// are stored in plaintext — the same "unconfigured → permissive" convention used
// by lib/server/auth.ts. Ciphertexts carry an "enc:v1:" prefix so decrypt() can
// tell encrypted values from plaintext (and from legacy rows written before a key
// was configured). Set APP_ENCRYPTION_KEY in production.
// ---------------------------------------------------------------------------

const PREFIX = "enc:v1:"

function key(): Buffer | null {
  const secret = process.env.APP_ENCRYPTION_KEY
  if (!secret) return null
  // Derive a stable 32-byte key from an arbitrary-length secret.
  return createHash("sha256").update(secret).digest()
}

// Encrypt a string. Returns plaintext unchanged when no key is configured.
export function encryptSecret(plaintext: string): string {
  const k = key()
  if (!k) return plaintext
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", k, iv)
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  // prefix + base64(iv | tag | ciphertext)
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64")
}

// Decrypt a value produced by encryptSecret. Values without the prefix are
// returned as-is (they were stored plaintext, e.g. before a key was set).
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored
  const k = key()
  if (!k) {
    // Encrypted value but no key available — cannot recover it.
    throw new Error("APP_ENCRYPTION_KEY is required to decrypt stored secrets")
  }
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64")
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const enc = raw.subarray(28)
  const decipher = createDecipheriv("aes-256-gcm", k, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")
}
