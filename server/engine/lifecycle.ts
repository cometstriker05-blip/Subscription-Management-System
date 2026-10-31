// State machines as data, so the rules can be read, tested and shown to a user.

export type SubscriptionStatus = 'draft' | 'quotation' | 'confirmed' | 'active' | 'paused' | 'closed';
export type InvoiceStatus = 'draft' | 'confirmed' | 'paid' | 'cancelled';

export const SUBSCRIPTION_FLOW: SubscriptionStatus[] = ['draft', 'quotation', 'confirmed', 'active', 'closed'];

const SUBSCRIPTION_MOVES: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  draft: ['quotation', 'closed'],
  quotation: ['confirmed', 'draft', 'closed'],
  confirmed: ['active', 'closed'],
  active: ['paused', 'closed'],
  paused: ['active', 'closed'],
  closed: [],
};

const INVOICE_MOVES: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['paid', 'cancelled'],
  paid: [],
  cancelled: [],
};

export const canMoveSubscription = (from: SubscriptionStatus, to: SubscriptionStatus) =>
  SUBSCRIPTION_MOVES[from].includes(to);

export const canMoveInvoice = (from: InvoiceStatus, to: InvoiceStatus) => INVOICE_MOVES[from].includes(to);

export interface PlanPolicy {
  autoClose: boolean;
  closable: boolean;
  pausable: boolean;
  renewable: boolean;
}

export type LifecycleAction = 'close' | 'pause' | 'renew';

/** What a plan allows. The admin decides this plan by plan. */
export function planAllows(policy: PlanPolicy, action: LifecycleAction): boolean {
  return { close: policy.closable, pause: policy.pausable, renew: policy.renewable }[action];
}

export type ExpiryOutcome = 'renew' | 'close' | 'needs_decision';

/** What happens when a contract reaches its expiry date. */
export function onExpiry(policy: PlanPolicy, autoRenew: boolean): ExpiryOutcome {
  if (autoRenew && policy.renewable) return 'renew';
  if (policy.autoClose) return 'close';
  return 'needs_decision';
}

const PASSWORD_SPECIAL = /[^A-Za-z0-9]/;

/** The brief says MORE than eight characters, so eight exactly must be rejected. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length <= 8) problems.push('Use more than 8 characters');
  if (!/[A-Z]/.test(password)) problems.push('Add an uppercase letter');
  if (!/[a-z]/.test(password)) problems.push('Add a lowercase letter');
  if (!PASSWORD_SPECIAL.test(password)) problems.push('Add a special character');
  return problems;
}
