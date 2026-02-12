'use strict';

const ALLOWED_TRANSITIONS = {
  pending_payment: new Set(['accepted', 'paid', 'cancelled']),
  accepted: new Set(['paid', 'confirmed', 'in_progress', 'completed', 'cancelled']),
  paid: new Set(['pending_payment', 'accepted', 'confirmed', 'in_progress', 'completed', 'cancelled']),
  confirmed: new Set(['in_progress', 'completed', 'cancelled']),
  in_progress: new Set(['completed', 'cancelled']),
  completed: new Set(['disputed']),
  disputed: new Set(['completed', 'cancelled']),
  cancelled: new Set(),
  refunded: new Set(),
};

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function canTransition(fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (!from || !to) return false;
  if (from === to) return true;
  const next = ALLOWED_TRANSITIONS[from];
  return !!next && next.has(to);
}

module.exports = {
  ALLOWED_TRANSITIONS,
  normalizeStatus,
  canTransition,
};
