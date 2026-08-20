"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOMAINS = ["www.growuppilot.com", "growuppilot.com", "zomin-order-crm.vercel.app"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return result.stdout || "";
}

function deploymentIdFromOutput(output) {
  const matches = String(output).match(/dpl_[A-Za-z0-9]+/g) || [];
  return matches.at(-1) || "";
}

function main() {
  run(process.execPath, [path.join(ROOT, "scripts", "production-preflight.js")], {
    inherit: true,
    env: {
      ...process.env,
      DEPLOYMENT_MANIFEST_PATH: process.env.DEPLOYMENT_MANIFEST_PATH || "/private/tmp/production-preflight-wrapper.json"
    }
  });
  const output = run("npx", ["--no-install", "vercel", "--prod", "--yes"]);
  process.stdout.write(output);
  const deploymentId = deploymentIdFromOutput(output);
  if (!deploymentId) {
    console.error("Production deploy did not return a deployment ID.");
    process.exit(1);
  }
  for (const domain of DOMAINS) {
    run("npx", ["--no-install", "vercel", "alias", "set", deploymentId, domain], { inherit: true });
  }
  const gateEnv = {
    ...process.env,
    INTENDED_PRODUCTION_DEPLOYMENT: deploymentId,
    ACTUAL_PRODUCTION_COMMIT: process.env.CANDIDATE_COMMIT || "",
    ROUTING_GATE_MANIFEST_PATH: process.env.ROUTING_GATE_MANIFEST_PATH || "/private/tmp/production-routing-gate.json"
  };
  const gate = spawnSync(process.execPath, [path.join(ROOT, "scripts", "production-routing-gate.js")], {
    cwd: ROOT,
    env: gateEnv,
    encoding: "utf8",
    stdio: "inherit"
  });
  process.exit(gate.status || 0);
}

if (require.main === module) main();

module.exports = { deploymentIdFromOutput };
