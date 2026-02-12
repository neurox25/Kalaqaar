'use strict';

// Central source of truth for settlement + tax behavior.
const PAYOUT_STAGE1_DELAY_HOURS = 0;
const PAYOUT_STAGE2_DELAY_HOURS = 12;
const DISPUTE_WINDOW_HOURS = 12;

const REQUIRE_PAN_FOR_PAYOUT = true;
const TDS_RATE_WITH_PAN = 0.001; // 0.1%
const TDS_RATE_NO_PAN = 0.05; // 5%
const TDS_FY_TURNOVER_EXEMPT_LIMIT = 500000; // INR 5L

const ECO_TCS_RATE = Number(process.env.ECO_TCS_RATE || '0.005'); // 0.5%
const ECO_TCS_BORNE_BY_PLATFORM = true;

const ESCROW_FEE_RATE = Number(process.env.ESCROW_FEE_RATE || '0.016'); // 1.6%

function roundInr(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function deriveFyTurnover(profile = {}, userData = {}) {
  const kyc = profile?.kyc && typeof profile.kyc === 'object' ? profile.kyc : {};
  const candidates = [
    profile?.artistFyTurnover,
    profile?.fyTurnover,
    profile?.financialYearTurnover,
    kyc?.artistFyTurnover,
    kyc?.fyTurnover,
    kyc?.financialYearTurnover,
    userData?.artistFyTurnover,
    userData?.fyTurnover,
    userData?.financialYearTurnover,
  ];
  for (const value of candidates) {
    const parsed = parseNumber(value);
    if (parsed !== null && parsed >= 0) return parsed;
  }
  return null;
}

function computeTdsForPayout({ serviceFee, panVerified, fyTurnover }) {
  const gross = Math.max(0, roundInr(serviceFee));
  const panOk = panVerified === true;
  const turnover = parseNumber(fyTurnover);

  let rate = 0;
  let reason = 'exempt_turnover';

  if (!panOk) {
    rate = TDS_RATE_NO_PAN;
    reason = 'pan_missing_or_unverified';
  } else if (turnover === null) {
    rate = TDS_RATE_WITH_PAN;
    reason = 'turnover_unknown_default_tds';
  } else if (turnover > TDS_FY_TURNOVER_EXEMPT_LIMIT) {
    rate = TDS_RATE_WITH_PAN;
    reason = 'above_turnover_threshold';
  }

  return {
    rate,
    amount: Math.max(0, roundInr(gross * rate)),
    reason,
    turnover,
  };
}

module.exports = {
  PAYOUT_STAGE1_DELAY_HOURS,
  PAYOUT_STAGE2_DELAY_HOURS,
  DISPUTE_WINDOW_HOURS,
  REQUIRE_PAN_FOR_PAYOUT,
  TDS_RATE_WITH_PAN,
  TDS_RATE_NO_PAN,
  TDS_FY_TURNOVER_EXEMPT_LIMIT,
  ECO_TCS_RATE,
  ECO_TCS_BORNE_BY_PLATFORM,
  ESCROW_FEE_RATE,
  roundInr,
  deriveFyTurnover,
  computeTdsForPayout,
};
