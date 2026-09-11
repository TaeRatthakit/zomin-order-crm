"use strict";

const fs = require("fs");
const path = require("path");

function fail(message) {
  throw new Error(`LINE credential settings test failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert(start !== -1, `${name}() is missing`);
  const bodyStart = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  fail(`${name}() has no complete body`);
}

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

const secretInputValue = new Function(`${extractFunction(server, "secretInputValue")}; return secretInputValue;`)();
assert(secretInputValue("", "existing-secret") === "existing-secret", "blank Secret must preserve the existing value");
assert(secretInputValue("__configured__", "existing-token") === "existing-token", "configured marker must preserve the existing value");
assert(secretInputValue("replacement", "existing-secret") === "replacement", "replacement Secret must be accepted");
assert(secretInputValue("__clear__", "existing-token") === "", "explicit clear marker must still clear the value");

const effectiveSettings = new Function(
  `${extractFunction(server, "booleanEnv")}; ${extractFunction(server, "effectiveSettings")}; return effectiveSettings;`
)();
const previousSecret = process.env.LINE_CHANNEL_SECRET;
const previousToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
process.env.LINE_CHANNEL_SECRET = "global-secret-fixture";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "global-token-fixture";
const tenantSettings = effectiveSettings({ lineChannelSecret: "tenant-secret-fixture", lineChannelAccessToken: "tenant-token-fixture" }, { tenantScoped: true });
assert(tenantSettings.lineChannelSecret === "tenant-secret-fixture", "tenant Secret must take precedence for tenant-scoped webhook handling");
assert(tenantSettings.lineChannelAccessToken === "tenant-token-fixture", "tenant token must take precedence for tenant-scoped webhook handling");
process.env.LINE_CHANNEL_SECRET = previousSecret;
process.env.LINE_CHANNEL_ACCESS_TOKEN = previousToken;

const secretInput = extractFunction(app, "lineSecretInput");
assert(secretInput.includes('type="${visible ? "text" : "password"}"'), "Secret and token inputs must remain password-style by default");
assert(!secretInput.includes('fromEnv ? "readonly"'), "configured Secret and token inputs must remain editable for replacement");
assert(secretInput.includes("ตั้งค่าไว้แล้ว — กรอกค่าใหม่เมื่อต้องการเปลี่ยน"), "configured-state copy must be explicit");
assert(secretInput.includes('value = ""'), "raw configured credentials must never be rendered into the input value");

const lineHub = extractFunction(app, "renderSettingsLineHub");
assert(lineHub.includes("lineChannelSecretConfigured"), "Channel Secret configured state is missing");
assert(lineHub.includes("lineChannelAccessTokenConfigured"), "Access Token configured state is missing");
assert(lineHub.includes("Webhook URL"), "Webhook URL must remain in the connection form");
assert(lineHub.includes("LINE Group ID"), "LINE Group ID must remain in the connection form");

assert(server.includes("lineChannelSecret: secretInputValue(body.lineChannelSecret, existingSettings.lineChannelSecret)"), "settings save must use the existing Secret preservation rule");
assert(server.includes("lineChannelAccessToken: secretInputValue(body.lineChannelAccessToken, existingSettings.lineChannelAccessToken)"), "settings save must use the existing token preservation rule");
assert(server.includes("delete publicBase.lineChannelSecret") && server.includes("delete publicBase.lineChannelAccessToken"), "API responses must not expose raw credentials");

console.log("LINE credential settings contract passed");
