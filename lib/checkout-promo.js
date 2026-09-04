"use strict";
const crypto = require("node:crypto");

// Explicit environment/data-source boundary. Never connects Preview to
// Production and never enables this consumer outside the matching deployment.
function checkoutPromoEnabled(env = process.env) {
  try {
    const environment = String(env.VERCEL_ENV || "").trim().toLowerCase();
    const provider = String(env.DATABASE_PROVIDER || "").trim().toLowerCase();
    const host = new URL(env.SUPABASE_URL).hostname.toLowerCase();
    const expectedHost = environment === "preview"
      ? "enwabsfsmwwcwwirdwok.supabase.co"
      : environment === "production"
        ? "mjnpzdmrqweugdnvlqwq.supabase.co"
        : "";
    return ["preview", "production"].includes(environment)
      && env.CHECKOUT_PROMO_ENABLED === "true"
      && provider === "supabase"
      && host === expectedHost;
  } catch { return false; }
}

function checkoutPromoError(error) {
  const detail = [error?.code, error?.detail, error?.message].filter(Boolean).join(" ");
  const messages = {
    PROMOTION_CODE_EXHAUSTED: "โค้ดโปรโมชั่นนี้ถูกใช้หรือจองครบจำนวนแล้ว",
    PROMOTION_CODE_EXPIRED: "โค้ดโปรโมชั่นนี้ยังไม่เริ่มใช้หรือหมดอายุแล้ว",
    PROMOTION_CODE_NEW_CUSTOMERS_ONLY: "โค้ดโปรโมชั่นนี้ใช้ได้เฉพาะลูกค้าใหม่ตอนสมัครเท่านั้น",
    PROMOTION_CHECKOUT_CONFLICT: "มีรายการชำระเงินเดิมอยู่ ไม่สามารถเปลี่ยนโปรโมชั่นของรายการเดิมได้",
    PROMOTION_CHECKOUT_SIGNUP_BENEFIT_PENDING: "รายการนี้มีสิทธิ์โปรโมชั่นจากการสมัครรอใช้อยู่แล้ว ไม่สามารถใช้โค้ดซ้อนได้",
    PROMOTION_CHECKOUT_POSITIVE_PAYMENT_REQUIRED: "ยอดหลังส่วนลดต้องมากกว่า 0 บาท เพื่อยืนยันการชำระเงินผ่าน Stripe",
    PROMOTION_CHECKOUT_STRIPE_MINIMUM: "ยอดหลังส่วนลดต้องไม่น้อยกว่า 10 บาท ตามยอดชำระขั้นต่ำของ Stripe",
    PROMOTION_CHECKOUT_NOT_ALLOWED: "โปรโมชั่นนี้ใช้ได้กับการต่ออายุหรืออัปเกรดที่รองรับเท่านั้น",
    PROMOTION_CODE_INVALID: "โค้ดโปรโมชั่นไม่ถูกต้องหรือไม่สามารถใช้กับแพ็กเกจนี้ได้",
    PROMOTION_QUOTE_CHANGED: "รายละเอียดโปรโมชั่นเปลี่ยนแปลง กรุณาตรวจสอบโค้ดอีกครั้งก่อนยืนยัน",
    PROMOTION_SERVICE_ALREADY_GRANTED: "มีสิทธิ์บริการฟรีที่ยังไม่สิ้นสุดอยู่แล้ว ไม่สามารถรับสิทธิ์ซ้อนกันได้"
  };
  const code = Object.keys(messages).find(key => detail.includes(key));
  return code ? { ok: false, code, error: messages[code] } : null;
}

function publicCheckoutPromotion(payment = {}) {
  const source = payment.checkoutMetadata?.promotion || payment.checkout_metadata?.promotion || payment.promotion;
  if (!source || typeof source !== "object") return null;
  return {
    code: String(source.code || ""),
    benefitType: String(source.benefit_type || source.benefitType || ""),
    benefitDescription: String(source.benefit_description || source.benefitDescription || ""),
    baseAmountMinor: Number(source.base_amount_minor ?? source.baseAmountMinor ?? 0),
    discountAmountMinor: Number(source.discount_amount_minor ?? source.discountAmountMinor ?? 0)
  };
}

function quoteSecret() {
  if (!checkoutPromoEnabled() || String(process.env.SESSION_SECRET || "").length < 32) throw new Error("PROMOTION_CHECKOUT_NOT_ALLOWED");
  return process.env.SESSION_SECRET;
}

function signCheckoutQuote(quote, user) {
  const claims = { version:1,tenantId:user.tenantId,userId:user.id,quote,
    nonce:crypto.randomUUID(),expires:Date.now()+15*60*1000 };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256",quoteSecret()).update(`checkout-promo-v1:${body}`).digest("base64url");
  return `${body}.${signature}`;
}

function verifyCheckoutQuote(token, user) {
  if (typeof token !== "string" || token.length>6000) throw new Error("PROMOTION_QUOTE_CHANGED");
  const [body,signature,extra] = token.split(".");
  const expected = crypto.createHmac("sha256",quoteSecret()).update(`checkout-promo-v1:${body}`).digest();
  const actual = Buffer.from(signature || "","base64url");
  if (extra || actual.length!==expected.length || !crypto.timingSafeEqual(actual,expected)) throw new Error("PROMOTION_QUOTE_CHANGED");
  let claims;
  try { claims=JSON.parse(Buffer.from(body,"base64url").toString()); } catch { throw new Error("PROMOTION_QUOTE_CHANGED"); }
  if (claims.version!==1 || claims.tenantId!==user.tenantId || claims.userId!==user.id || !(claims.expires>Date.now())) throw new Error("PROMOTION_QUOTE_CHANGED");
  return { ...claims.quote,requestKey:crypto.createHash("sha256").update(token).digest("hex") };
}

function effectivePromoSubscription(base, snapshot, now = Date.now()) {
  if (!base || !["active","trialing","expired","pending_payment"].includes(base.status)) return base;
  const grants = Array.isArray(snapshot?.zero_payment_entitlements) ? snapshot.zero_payment_entitlements : [];
  const grant = grants.find(item => item.version===1 && item.source==="promotion_zero_payment" && item.state==="granted"
    && item.tenant_id===base.tenantId && item.subscription_id===base.id
    && ["starter","business","enterprise"].includes(item.plan)
    && Date.parse(item.starts_at)<=now && Date.parse(item.ends_at)>now);
  if (!grant) return base;
  const rank={starter:0,business:1,enterprise:2};
  if (rank[base.plan]>rank[grant.plan] && require("./subscription-lifecycle").subscriptionAccess(base,new Date(now)).allowed) return base;
  return { ...base,plan:grant.plan,status:"active",billingInterval:grant.billing_interval,
    amountDueMinor:0,currentPeriodStartedAt:grant.starts_at,currentPeriodEndsAt:grant.ends_at,
    nextRenewalAt:grant.ends_at,paymentDueAt:grant.ends_at,
    promoEntitlement:{code:grant.code,unit:grant.unit,value:grant.value,startsAt:grant.starts_at,endsAt:grant.ends_at,redemptionId:grant.redemption_id},
    basePlan:base.plan };
}

module.exports = { checkoutPromoEnabled, checkoutPromoError, publicCheckoutPromotion,
  signCheckoutQuote, verifyCheckoutQuote, effectivePromoSubscription };
