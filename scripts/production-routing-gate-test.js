"use strict";

const { evaluateCanonicalRoutingEvidence } = require("./production-routing-gate");

const intendedDeployment = "dpl_verified";
const domains = ["www.growuppilot.com", "growuppilot.com", "zomin-order-crm.vercel.app"];
const deploymentInspection = { id: intendedDeployment, readyState: "READY", target: "production" };
const sourceCheck = { ok: true, errors: [] };

function evidence(overrides = {}) {
  return {
    "www.growuppilot.com": {
      kind: "deployment", deploymentId: intendedDeployment, httpStatus: 200, readyMessage: true
    },
    "growuppilot.com": {
      kind: "redirect", location: "https://www.growuppilot.com/api/line/webhook?__routing_gate=test", httpStatus: 308
    },
    "zomin-order-crm.vercel.app": {
      kind: "deployment", deploymentId: intendedDeployment, httpStatus: 200, readyMessage: true
    },
    ...overrides
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`Production routing gate test failed: ${message}`);
}

let result = evaluateCanonicalRoutingEvidence({ intendedDeployment, deploymentInspection, domains, evidence: evidence(), sourceCheck });
assert(result.ok, "verified candidate and canonical routing should pass");

result = evaluateCanonicalRoutingEvidence({
  intendedDeployment, deploymentInspection, domains,
  evidence: evidence({ "www.growuppilot.com": { kind: "deployment", deploymentId: "dpl_stale", httpStatus: 200, readyMessage: true } }),
  sourceCheck
});
assert(!result.ok && result.errors.some(error => error.includes("www.growuppilot.com")), "stale canonical deployment should fail");

result = evaluateCanonicalRoutingEvidence({
  intendedDeployment, deploymentInspection, domains,
  evidence: evidence({ "www.growuppilot.com": { kind: "deployment", deploymentId: "dpl_stale", httpStatus: 200, readyMessage: true } }),
  sourceCheck
});
assert(!result.ok, "alias command success must not override stale live evidence");

result = evaluateCanonicalRoutingEvidence({
  intendedDeployment, deploymentInspection, domains, evidence: evidence(),
  sourceCheck: { ok: false, errors: ["Backend critical contract is incomplete."] }
});
assert(!result.ok && result.errors.some(error => error.includes("Backend critical")), "stale backend source should fail");

result = evaluateCanonicalRoutingEvidence({
  intendedDeployment, deploymentInspection, domains,
  evidence: evidence({ "zomin-order-crm.vercel.app": { kind: "deployment", deploymentId: "dpl_other", httpStatus: 200, readyMessage: true } }),
  sourceCheck
});
assert(!result.ok && result.errors.some(error => error.includes("zomin-order-crm.vercel.app")), "canonical and alias divergence should fail");

console.log("Production canonical routing gate tests passed.");
