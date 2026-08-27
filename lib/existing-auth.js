"use strict";

const { findUserForLogin } = require("./db");
const { hashPassword, verifyPassword } = require("./auth");

/**
 * The single authoritative username/password authentication path used by
 * both the customer application and the isolated Platform Admin login.
 *
 * `upgraded` is intentionally returned to the customer route so it can retain
 * the existing legacy-password migration behavior. Platform Admin consumes
 * the normalized user in memory only and never persists an upgrade.
 */
async function authenticateExistingUser(identifier, password) {
  const value = String(identifier || "").trim();
  if (!value) {
    return { user: null, upgraded: false, reason: "missing_identifier" };
  }

  const found = typeof findUserForLogin === "function"
    ? await findUserForLogin(value)
    : null;
  if (!found || found.active === false || found.is_active === false) {
    return { user: null, upgraded: false, reason: "user_not_found" };
  }

  const user = { ...found };
  let upgraded = false;
  if (user.passwordHash) {
    // Already in the current authoritative format.
  } else if (user.password_hash) {
    user.passwordHash = user.password_hash;
    delete user.password_hash;
    upgraded = true;
  } else {
    const legacyPlain = String(password || user.password || user.pin || "");
    if (legacyPlain) {
      user.passwordHash = hashPassword(legacyPlain);
      delete user.password;
      delete user.pin;
      upgraded = true;
    }
  }

  const passwordVerified = verifyPassword(password, user.passwordHash);
  if (!passwordVerified) {
    return { user: null, upgraded: false, reason: "invalid_credentials" };
  }
  return { user, upgraded, reason: "authenticated" };
}

module.exports = { authenticateExistingUser };
