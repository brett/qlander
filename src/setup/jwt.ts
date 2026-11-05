// A GitHub App's JWT (RS256), signed with node:crypto: no dependency.
// GitHub accepts the App's client id as `iss`, and a token valid for at most
// ten minutes; `iat` is backdated a minute for clock drift.

import { createPrivateKey, sign } from "node:crypto";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function appJwt(clientId: string, pem: string, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId }));
  const data = `${header}.${payload}`;
  const sig = sign("RSA-SHA256", Buffer.from(data), createPrivateKey(pem));
  return `${data}.${b64url(sig)}`;
}
