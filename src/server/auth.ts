import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export interface AuthConfig { username: string; passwordHash: string; sessionSecret: string; secureCookie?: boolean }
const sessionLifetime = 7 * 24 * 60 * 60;

function encode(value: string): string { return Buffer.from(value).toString("base64url"); }
function sign(value: string, secret: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
export function passwordHash(password: string, salt = randomBytes(16).toString("hex")): string {
  return `scrypt:${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}
export function verifyPassword(password: string, encoded: string): boolean {
  const [kind, salt, expected] = encoded.split(":");
  if (kind !== "scrypt" || !salt || !expected || expected.length !== 64) return false;
  const actual = scryptSync(password, salt, 32);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
export function issueSession(username: string, secret: string, now = Date.now()): string {
  const payload = encode(JSON.stringify({ sub: username, exp: Math.floor(now / 1000) + sessionLifetime }));
  return `${payload}.${sign(payload, secret)}`;
}
export function verifySession(token: string | undefined, config: AuthConfig, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = sign(payload, config.sessionSecret);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try { const value = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub?: string; exp?: number };
    return value.sub === config.username && typeof value.exp === "number" && value.exp >= now / 1000;
  } catch { return false; }
}
export function cookies(header: string | undefined): Record<string, string> {
  return Object.fromEntries((header ?? "").split(";").map(v => v.trim().split("=")).filter(v => v.length === 2) as [string,string][]);
}
export function cookie(name: string, value: string, options: { httpOnly?: boolean; secure?: boolean; maxAge?: number } = {}): string {
  return [`${name}=${value}`, "Path=/", "SameSite=Strict", options.httpOnly ? "HttpOnly" : "", options.secure ? "Secure" : "", options.maxAge !== undefined ? `Max-Age=${options.maxAge}` : ""].filter(Boolean).join("; ");
}
export function newCsrf(): string { return randomBytes(24).toString("base64url"); }
