import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Hash format: scrypt$N$r$p$salt(b64)$hash(b64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  const key = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Password policy: length-based (NIST SP 800-63B), with a small deny list. */
export function passwordProblems(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push("Password must be at least 12 characters");
  if (password.length > 256) problems.push("Password must be at most 256 characters");
  const lower = password.toLowerCase();
  if (["password1234", "123456789012", "qwertyuiop12"].includes(lower))
    problems.push("Password is too common");
  if (email && lower.includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4)
    problems.push("Password must not contain your email name");
  return problems;
}

/** Random temporary password for admin-created accounts (shown once). */
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}
