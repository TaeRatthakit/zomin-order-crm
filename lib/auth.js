const crypto = require("crypto");
require("./env").loadEnv();

const COOKIE_NAME = "zomin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function base64urlJson(value) {
  return base64url(JSON.stringify(value));
}

function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET or JWT_SECRET is required when NODE_ENV=production");
  }
  return "zomin-dev-secret-change-me";
}

function sign(input) {
  return crypto
    .createHmac("sha256", getSessionSecret())
    .update(input)
    .digest("base64url");
}

function decodeBase64urlJson(input) {
  return JSON.parse(Buffer.from(input, "base64url").toString("utf8"));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!String(stored).startsWith("scrypt$")) {
    return String(password) === String(stored);
  }
  const [, salt, expected] = String(stored).split("$");
  const actual = crypto.scryptSync(String(password), salt, 64);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), actual);
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function createSession(user) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: user.id,
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    phone: user.phone || "",
    active: user.active !== false,
    exp: Math.floor(expiresAt / 1000),
    iat: Math.floor(Date.now() / 1000),
    jti: base64url(crypto.randomBytes(12))
  };
  const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const token = `${unsigned}.${sign(unsigned)}`;
  return { token, expiresAt };
}

function getSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = sign(unsigned);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
  } catch {
    return null;
  }
  try {
    const payload = decodeBase64urlJson(parts[1]);
    const expiresAt = Number(payload.exp || 0) * 1000;
    if (!expiresAt || expiresAt < Date.now()) return null;
    return {
      token,
      expiresAt,
      user: {
        id: payload.id || payload.sub,
        username: payload.username,
        name: payload.name,
        role: payload.role,
        phone: payload.phone || "",
        active: payload.active !== false
      }
    };
  } catch {
    return null;
  }
}

function destroySession(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

function sessionCookie(token, expiresAt) {
  const expires = new Date(expiresAt).toUTCString();
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  sessionCookie,
  clearSessionCookie
};
