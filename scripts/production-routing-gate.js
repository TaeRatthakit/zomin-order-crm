"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { check: preflightCheck } = require("./production-preflight");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CANONICAL_DOMAINS = [
  "www.growuppilot.com",
  "growuppilot.com",
  "zomin-order-crm.vercel.app"
];
const ROUTING_PATH = "/api/line/webhook";
const READY_MESSAGE = "Growup Pilot LINE webhook endpoint is ready";

function envDomains(env = process.env) {
  return String(env.CANONICAL_PRODUCTION_DOMAINS || DEFAULT_CANONICAL_DOMAINS.join(","))
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function runVercel(args, options = {}) {
  return execFileSync("npx", ["--no-install", "vercel", ...args], {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function parseJsonLines(output = "") {
  return String(output)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" ? [value] : [];
      } catch {
        return [];
      }
    });
}

function inspectDeployment(deploymentId) {
  const output = runVercel(["inspect", deploymentId, "--json"]);
  return JSON.parse(output);
}

function sourceAlignment(env, candidateCommit) {
  const actualCommit = String(env.ACTUAL_PRODUCTION_COMMIT || candidateCommit || "").trim();
  if (!actualCommit || actualCommit !== candidateCommit) {
    return {
      ok: false,
      errors: ["Actual Production source commit is not explicitly aligned with the candidate commit."],
      actualCommit,
      candidateCommit
    };
  }
  const result = preflightCheck({
    cwd: ROOT,
    env: {
      ...env,
      CANDIDATE_COMMIT: actualCommit,
      REQUIRED_BACKEND_TESTS_PASSED: env.REQUIRED_BACKEND_TESTS_PASSED || "true"
    }
  });
  return {
    ok: result.ok,
    errors: result.errors,
    actualCommit,
    candidateCommit,
    manifest: result.manifest
  };
}

function evaluateCanonicalRoutingEvidence({
  intendedDeployment,
  deploymentInspection,
  domains = DEFAULT_CANONICAL_DOMAINS,
  evidence = {},
  sourceCheck = { ok: false, errors: ["Source check was not run."] }
}) {
  const errors = [];
  if (!intendedDeployment) errors.push("Intended Production deployment is required.");
  if (deploymentInspection?.id !== intendedDeployment) errors.push("Vercel inspection does not match the intended deployment.");
  if (deploymentInspection?.readyState !== "READY") errors.push("Intended deployment is not READY.");
  if (deploymentInspection?.target !== "production") errors.push("Intended deployment is not a Production deployment.");
  if (!sourceCheck.ok) errors.push(...(sourceCheck.errors || ["Production source alignment failed."]));

  const canonicalDomain = domains.find(domain => domain.startsWith("www.")) || "www.growuppilot.com";
  for (const domain of domains) {
    const item = evidence[domain];
    if (!item) {
      errors.push(`${domain}: no live evidence.`);
      continue;
    }
    if (domain === "growuppilot.com" && item.kind === "redirect") {
      if (!String(item.location || "").startsWith(`https://${canonicalDomain}${ROUTING_PATH}`)) {
        errors.push(`${domain}: redirect does not preserve the canonical www route.`);
      }
      continue;
    }
    if (item.kind !== "deployment" || item.deploymentId !== intendedDeployment) {
      errors.push(`${domain}: canonical domain is not served by the intended deployment.`);
    }
    if (item.httpStatus !== 200) errors.push(`${domain}: readiness request did not return HTTP 200.`);
    if (item.readyMessage !== true) errors.push(`${domain}: readiness response was not verified.`);
  }
  return {
    ok: errors.length === 0,
    errors,
    intendedDeployment,
    domains,
    evidence,
    sourceCheck
  };
}

async function requestLiveDomain(domain, nonce, fetchImpl = fetch) {
  const url = `https://${domain}${ROUTING_PATH}?__routing_gate=${encodeURIComponent(nonce)}`;
  const response = await fetchImpl(url, { redirect: "manual", headers: { "user-agent": "growup-production-routing-gate" } });
  const body = await response.text();
  const location = response.headers.get("location") || "";
  return {
    domain,
    url,
    httpStatus: response.status,
    location,
    readyMessage: body.includes(READY_MESSAGE),
    kind: response.status >= 300 && response.status < 400 ? "redirect" : "deployment"
  };
}

function logEvidenceForDomain(domain, since, until, nonce, env = process.env) {
  const output = runVercel([
    "logs",
    "--environment", "production",
    "--since", since,
    "--until", until,
    "--expand",
    "--json",
    "--limit", String(env.ROUTING_GATE_LOG_LIMIT || 200)
  ]);
  const logs = parseJsonLines(output).filter(log => (
    log.domain === domain
    && log.requestMethod === "GET"
    && String(log.requestPath || "").startsWith(ROUTING_PATH)
    && Number(log.timestamp || 0) >= Date.parse(since) - 5000
    && (!nonce || String(log.requestPath || "").includes(nonce) || Number(log.timestamp || 0) >= Date.parse(since))
  ));
  const latest = logs.sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0))[0];
  return latest ? { deploymentId: latest.deploymentId, requestId: latest.id, log: latest } : null;
}

async function collectDomainEvidence(domains, env = process.env) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const evidence = {};
  for (const domain of domains) {
    const response = await requestLiveDomain(domain, nonce);
    if (domain === "growuppilot.com" && response.kind === "redirect") {
      evidence[domain] = response;
      continue;
    }
    const since = new Date(Date.now() - 5000).toISOString();
    const until = new Date().toISOString();
    let logEvidence = null;
    for (let attempt = 0; attempt < 6 && !logEvidence; attempt += 1) {
      logEvidence = logEvidenceForDomain(domain, since, until, nonce, env);
      if (!logEvidence) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    evidence[domain] = { ...response, ...(logEvidence || {}) };
  }
  return evidence;
}

async function main() {
  const env = process.env;
  const intendedDeployment = String(env.INTENDED_PRODUCTION_DEPLOYMENT || "").trim();
  const candidateCommit = String(env.CANDIDATE_COMMIT || "").trim();
  const domains = envDomains(env);
  const errors = [];
  let deploymentInspection = null;
  let sourceCheck = { ok: false, errors: ["Source check was not run."] };
  let evidence = {};
  try {
    deploymentInspection = inspectDeployment(intendedDeployment);
  } catch (error) {
    errors.push(`Vercel deployment inspection failed: ${String(error.message || error).slice(0, 300)}`);
  }
  sourceCheck = sourceAlignment(env, candidateCommit);
  try {
    evidence = await collectDomainEvidence(domains, env);
  } catch (error) {
    errors.push(`Live canonical routing probe failed: ${String(error.message || error).slice(0, 300)}`);
  }
  const result = evaluateCanonicalRoutingEvidence({
    intendedDeployment,
    deploymentInspection,
    domains,
    evidence,
    sourceCheck
  });
  result.errors.push(...errors);
  result.ok = result.errors.length === 0;
  const output = env.ROUTING_GATE_MANIFEST_PATH || path.join(ROOT, "artifacts", "production-routing-gate.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify({ ...result, generatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  if (!result.ok) {
    console.error("BLOCKED / CANONICAL DOMAIN NOT ON VERIFIED DEPLOYMENT");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Production canonical routing gate passed. Manifest: ${output}`);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_CANONICAL_DOMAINS,
  ROUTING_PATH,
  evaluateCanonicalRoutingEvidence,
  envDomains,
  requestLiveDomain,
  parseJsonLines
};
