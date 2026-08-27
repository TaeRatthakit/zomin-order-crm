"use strict";

const PLAN_IDS = Object.freeze(["starter", "business", "enterprise"]);
const BILLING_INTERVALS = Object.freeze(["monthly", "yearly"]);
const PLAN_ORDER = Object.freeze({ starter: 0, business: 1, enterprise: 2 });
const PRICE_CATALOG_MINOR = Object.freeze({
  starter: Object.freeze({ monthly: 49000, yearly: 490000 }),
  business: Object.freeze({ monthly: 99000, yearly: 990000 }),
  enterprise: Object.freeze({ monthly: 199000, yearly: 1990000 })
});

function subscriptionTimestamp(subscription = {}, camelKey, snakeKey) {
  const value = subscription?.[camelKey] || subscription?.[snakeKey] || "";
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function subscriptionAccess(subscription = null, now = new Date()) {
  if (!subscription) {
    return {
      allowed: true,
      reason: "legacy_no_subscription",
      requiresPayment: false,
      effectiveStatus: "active",
      expiresAt: "",
      daysRemaining: null,
      warningMilestone: null
    };
  }

  const status = String(subscription.status || "").trim().toLowerCase();
  const trialEnds = subscriptionTimestamp(subscription, "trialEndsAt", "trial_ends_at");
  const periodEnds = subscriptionTimestamp(subscription, "currentPeriodEndsAt", "current_period_ends_at");
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const validNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  let allowed = false;
  let reason = status || "subscription_inactive";
  let expiresAtMs = 0;

  if (status === "trialing" && trialEnds > validNow) {
    allowed = true;
    reason = "trialing";
    expiresAtMs = trialEnds;
  } else if (status === "active" && periodEnds > validNow) {
    allowed = true;
    reason = "active";
    expiresAtMs = periodEnds;
  } else if (status === "active" && !periodEnds) {
    // Compatibility for approved legacy tenants backfilled before paid periods
    // existed. Every new payment created by the lifecycle RPC has a period end.
    allowed = true;
    reason = "legacy_active_no_period";
  } else if ((status === "trialing" && trialEnds && trialEnds <= validNow)
    || (status === "active" && periodEnds && periodEnds <= validNow)) {
    reason = "expired";
  }

  const remainingMs = allowed && expiresAtMs ? Math.max(0, expiresAtMs - validNow) : 0;
  const daysRemaining = expiresAtMs ? Math.ceil(remainingMs / 86400000) : null;
  const warningMilestone = allowed && daysRemaining !== null && daysRemaining <= 7
    ? (daysRemaining <= 1 ? 1 : (daysRemaining <= 3 ? 3 : 7))
    : null;

  return {
    allowed,
    reason,
    requiresPayment: !allowed,
    effectiveStatus: allowed ? (reason === "trialing" ? "trialing" : "active") : "expired",
    expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : "",
    daysRemaining,
    warningMilestone
  };
}

function authoritativePriceMinor(plan, billingInterval) {
  const normalizedPlan = String(plan || "").trim().toLowerCase();
  const normalizedInterval = String(billingInterval || "").trim().toLowerCase();
  return Number(PRICE_CATALOG_MINOR[normalizedPlan]?.[normalizedInterval] || 0);
}

function subscriptionCheckoutIntent(subscription = {}, targetPlan = "", billingInterval = "") {
  const currentPlan = String(subscription.plan || "").trim().toLowerCase();
  const nextPlan = String(targetPlan || "").trim().toLowerCase();
  const nextInterval = String(billingInterval || "").trim().toLowerCase();
  if (!PLAN_IDS.includes(currentPlan) || !PLAN_IDS.includes(nextPlan) || !BILLING_INTERVALS.includes(nextInterval)) return "";
  if (PLAN_ORDER[nextPlan] < PLAN_ORDER[currentPlan]) return "";
  return nextPlan === currentPlan ? "subscription_renewal" : "subscription_upgrade";
}

module.exports = {
  PLAN_IDS,
  BILLING_INTERVALS,
  PLAN_ORDER,
  PRICE_CATALOG_MINOR,
  subscriptionAccess,
  authoritativePriceMinor,
  subscriptionCheckoutIntent
};
