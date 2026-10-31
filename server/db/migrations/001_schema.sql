-- Keel schema. Rules that must never break live here as constraints and triggers,
-- so a bug in application code still cannot double-bill or corrupt a total.

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE user_role AS ENUM ('admin', 'staff', 'customer');
CREATE TYPE billing_unit AS ENUM ('daily', 'weekly', 'monthly', 'yearly');
CREATE TYPE subscription_status AS ENUM ('draft', 'quotation', 'confirmed', 'active', 'paused', 'closed');
CREATE TYPE invoice_status AS ENUM ('draft', 'confirmed', 'paid', 'cancelled');
CREATE TYPE supply_type AS ENUM ('intra', 'inter', 'export');
CREATE TYPE discount_kind AS ENUM ('fixed', 'percent');
CREATE TYPE discount_scope AS ENUM ('subscription', 'products');
CREATE TYPE period_state AS ENUM ('billed', 'voided', 'waived');
CREATE TYPE payment_method AS ENUM ('upi', 'bank_transfer', 'card', 'cash', 'cheque', 'tds', 'gateway');
CREATE TYPE mrr_kind AS ENUM ('new', 'expansion', 'contraction', 'churn', 'reactivation');
CREATE TYPE bank_line_status AS ENUM ('auto_posted', 'suggested', 'unmatched', 'confirmed', 'ignored');

-- The business clock. In simulation it moves with the time machine; in production
-- it follows the real calendar. Every date in the system reads from here.
CREATE TABLE app_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  today date NOT NULL,
  clock_mode text NOT NULL DEFAULT 'simulated' CHECK (clock_mode IN ('simulated', 'live')),
  auto_confirm boolean NOT NULL DEFAULT false,
  company jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE payment_terms (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  net_days int NOT NULL CHECK (net_days >= 0)
);

CREATE TABLE customers (
  id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  email citext NOT NULL,
  phone text,
  gstin text,
  state_code char(2),
  state_name text,
  city text,
  address text,
  country char(2) NOT NULL DEFAULT 'IN',
  segment text NOT NULL DEFAULT 'small' CHECK (segment IN ('small', 'mid', 'enterprise')),
  payment_term_id bigint REFERENCES payment_terms,
  created_on date NOT NULL
);
CREATE INDEX customers_name_trgm ON customers USING gin (name gin_trgm_ops);
CREATE INDEX customers_email ON customers (email);

CREATE TABLE users (
  id bigserial PRIMARY KEY,
  email citext NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL,
  role user_role NOT NULL,
  customer_id bigint REFERENCES customers,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  -- citext makes this case-insensitive: a@x.com and A@X.com are one account.
  CONSTRAINT one_account_per_email UNIQUE (email),
  CONSTRAINT customers_link_to_a_company CHECK ((role = 'customer') = (customer_id IS NOT NULL))
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE products (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('software', 'service', 'addon', 'goods')),
  sales_price bigint NOT NULL CHECK (sales_price >= 0),
  cost_price bigint NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  notes text,
  tax_category text NOT NULL DEFAULT 'software',
  sac text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_variants (
  id bigserial PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES products ON DELETE CASCADE,
  attribute text NOT NULL,
  value text NOT NULL,
  price_extra bigint NOT NULL DEFAULT 0,
  UNIQUE (product_id, attribute, value)
);

CREATE TABLE plans (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  product_id bigint REFERENCES products,
  price bigint NOT NULL CHECK (price >= 0),
  billing_unit billing_unit NOT NULL,
  billing_interval int NOT NULL DEFAULT 1 CHECK (billing_interval > 0),
  min_quantity int NOT NULL DEFAULT 1 CHECK (min_quantity > 0),
  available_from date,
  available_until date,
  auto_close boolean NOT NULL DEFAULT false,
  closable boolean NOT NULL DEFAULT true,
  pausable boolean NOT NULL DEFAULT false,
  renewable boolean NOT NULL DEFAULT true,
  term_months int NOT NULL DEFAULT 12 CHECK (term_months > 0),
  notes text,
  active boolean NOT NULL DEFAULT true,
  CHECK (available_until IS NULL OR available_from IS NULL OR available_until >= available_from)
);

-- Add-ons a plan offers, which customers switch on and off themselves.
CREATE TABLE plan_addons (
  plan_id bigint NOT NULL REFERENCES plans ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products,
  price bigint NOT NULL CHECK (price >= 0),
  PRIMARY KEY (plan_id, product_id)
);

CREATE TABLE tax_rules (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  tax_category text,
  supply supply_type,
  components jsonb NOT NULL,
  valid_from date,
  valid_until date,
  priority int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE discounts (
  id bigserial PRIMARY KEY,
  code citext NOT NULL UNIQUE,
  name text NOT NULL,
  kind discount_kind NOT NULL,
  value bigint NOT NULL CHECK (value > 0),
  min_purchase bigint NOT NULL DEFAULT 0,
  min_quantity int NOT NULL DEFAULT 0,
  valid_from date,
  valid_until date,
  usage_limit int CHECK (usage_limit IS NULL OR usage_limit > 0),
  times_used int NOT NULL DEFAULT 0,
  scope discount_scope NOT NULL DEFAULT 'subscription',
  auto_apply boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES users,
  CONSTRAINT percent_is_at_most_100 CHECK (kind <> 'percent' OR value <= 10000),
  -- Two invoices racing for the last use cannot both win.
  CONSTRAINT usage_stays_within_limit CHECK (usage_limit IS NULL OR times_used <= usage_limit)
);

CREATE TABLE discount_products (
  discount_id bigint NOT NULL REFERENCES discounts ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products,
  PRIMARY KEY (discount_id, product_id)
);

CREATE TABLE quotation_templates (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  plan_id bigint NOT NULL REFERENCES plans,
  validity_days int NOT NULL DEFAULT 30 CHECK (validity_days > 0),
  notes text,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE quotation_template_lines (
  id bigserial PRIMARY KEY,
  template_id bigint NOT NULL REFERENCES quotation_templates ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products,
  variant_id bigint REFERENCES product_variants,
  quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price bigint,
  sort int NOT NULL DEFAULT 0
);

CREATE SEQUENCE subscription_number_seq START 1;

CREATE TABLE subscriptions (
  id bigserial PRIMARY KEY,
  number text NOT NULL UNIQUE,
  customer_id bigint NOT NULL REFERENCES customers,
  plan_id bigint NOT NULL REFERENCES plans,
  status subscription_status NOT NULL DEFAULT 'draft',
  start_date date NOT NULL,
  expiry_date date,
  billing_anchor date NOT NULL,
  next_period_index int NOT NULL DEFAULT 0,
  next_billing_date date,
  payment_term_id bigint NOT NULL REFERENCES payment_terms,
  auto_renew boolean NOT NULL DEFAULT true,
  template_id bigint REFERENCES quotation_templates,
  quotation_valid_until date,
  owner_id bigint REFERENCES users,
  notes text,
  recurring_amount bigint NOT NULL DEFAULT 0,
  mrr bigint NOT NULL DEFAULT 0,
  paused_on date,
  activated_on date,
  closed_on date,
  close_reason text,
  created_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expiry_date IS NULL OR expiry_date > start_date)
);
CREATE INDEX subscriptions_due ON subscriptions (next_billing_date) WHERE status = 'active';
CREATE INDEX subscriptions_status ON subscriptions (status, id DESC);
CREATE INDEX subscriptions_customer ON subscriptions (customer_id);
CREATE INDEX subscriptions_plan ON subscriptions (plan_id, status);
CREATE INDEX subscriptions_expiry ON subscriptions (expiry_date) WHERE status IN ('active', 'paused');
CREATE INDEX subscriptions_number_trgm ON subscriptions USING gin (number gin_trgm_ops);

CREATE TABLE subscription_lines (
  id bigserial PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES subscriptions ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products,
  variant_id bigint REFERENCES product_variants,
  description text NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  unit_price bigint NOT NULL CHECK (unit_price >= 0),
  variant_extra bigint NOT NULL DEFAULT 0,
  is_addon boolean NOT NULL DEFAULT false,
  active_from date,
  active_until date,
  sort int NOT NULL DEFAULT 0
);
CREATE INDEX subscription_lines_sub ON subscription_lines (subscription_id);

CREATE TABLE pending_charges (
  id bigserial PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES subscriptions ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products,
  description text NOT NULL,
  amount bigint NOT NULL,
  created_on date NOT NULL,
  invoice_id bigint
);
CREATE INDEX pending_charges_open ON pending_charges (subscription_id) WHERE invoice_id IS NULL;

CREATE TABLE subscription_discounts (
  subscription_id bigint NOT NULL REFERENCES subscriptions ON DELETE CASCADE,
  discount_id bigint NOT NULL REFERENCES discounts,
  attached_on date NOT NULL,
  PRIMARY KEY (subscription_id, discount_id)
);
CREATE INDEX subscription_discounts_discount ON subscription_discounts (discount_id);

CREATE TABLE subscription_events (
  id bigserial PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES subscriptions ON DELETE CASCADE,
  kind text NOT NULL,
  from_status subscription_status,
  to_status subscription_status,
  actor text NOT NULL DEFAULT 'Keel',
  on_date date NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_events_sub ON subscription_events (subscription_id, id DESC);

CREATE TABLE billing_runs (
  id bigserial PRIMARY KEY,
  run_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rehearsal', 'manual', 'scheduled', 'chaos')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  actor text NOT NULL DEFAULT 'Keel',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  subscriptions int NOT NULL DEFAULT 0,
  invoices int NOT NULL DEFAULT 0,
  total bigint NOT NULL DEFAULT 0,
  blocked_duplicates int NOT NULL DEFAULT 0,
  faults_injected int NOT NULL DEFAULT 0,
  fingerprint text,
  summary jsonb NOT NULL DEFAULT '{}'
);

CREATE SEQUENCE payment_number_seq START 1;

CREATE TABLE invoices (
  id bigserial PRIMARY KEY,
  number text UNIQUE,
  fy text,
  serial int,
  subscription_id bigint NOT NULL REFERENCES subscriptions,
  customer_id bigint NOT NULL REFERENCES customers,
  status invoice_status NOT NULL DEFAULT 'draft',
  issue_date date NOT NULL,
  due_date date NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  supply supply_type NOT NULL,
  subtotal bigint NOT NULL,
  discount bigint NOT NULL DEFAULT 0,
  taxable bigint NOT NULL,
  tax bigint NOT NULL,
  total bigint NOT NULL,
  amount_paid bigint NOT NULL DEFAULT 0,
  tax_summary jsonb NOT NULL DEFAULT '[]',
  customer_snapshot jsonb NOT NULL,
  -- The exact engine input, kept so any invoice can be replayed and proven later.
  engine_input jsonb NOT NULL,
  run_id bigint REFERENCES billing_runs,
  sent_at timestamptz,
  confirmed_at timestamptz,
  paid_on date,
  cancelled_on date,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paid_cannot_exceed_total CHECK (amount_paid >= 0 AND amount_paid <= total),
  CONSTRAINT taxable_adds_up CHECK (taxable = subtotal - discount),
  CONSTRAINT total_adds_up CHECK (total = taxable + tax),
  CONSTRAINT period_is_forward CHECK (period_end > period_start),
  CONSTRAINT numbered_when_confirmed CHECK (status IN ('draft', 'cancelled') OR number IS NOT NULL),
  CONSTRAINT one_serial_per_year UNIQUE (fy, serial)
);
CREATE INDEX invoices_subscription ON invoices (subscription_id, period_start DESC);
CREATE INDEX invoices_customer ON invoices (customer_id, issue_date DESC);
CREATE INDEX invoices_status_issue ON invoices (status, issue_date DESC, id DESC);
CREATE INDEX invoices_outstanding ON invoices (due_date) WHERE status = 'confirmed';
CREATE INDEX invoices_issue ON invoices (issue_date);
CREATE INDEX invoices_run ON invoices (run_id);
CREATE INDEX invoices_number_trgm ON invoices USING gin (number gin_trgm_ops);

CREATE TABLE invoice_lines (
  id bigserial PRIMARY KEY,
  invoice_id bigint NOT NULL REFERENCES invoices ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products,
  variant_id bigint,
  description text NOT NULL,
  sac text,
  quantity int NOT NULL,
  unit_price bigint NOT NULL,
  gross bigint NOT NULL,
  discount bigint NOT NULL DEFAULT 0,
  taxable bigint NOT NULL,
  tax bigint NOT NULL,
  amount bigint NOT NULL,
  taxes jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id);

-- The guarantee behind "nothing billed twice". One row per billed period. The
-- exclusion constraint refuses any overlapping period for the same subscription,
-- under any concurrency, whatever the application tries to do.
CREATE TABLE billing_periods (
  id bigserial PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES subscriptions,
  period_index int NOT NULL,
  period daterange NOT NULL,
  state period_state NOT NULL DEFAULT 'billed',
  invoice_id bigint REFERENCES invoices,
  replaced_by bigint REFERENCES billing_periods,
  run_id bigint REFERENCES billing_runs,
  CONSTRAINT never_billed_twice EXCLUDE USING gist (subscription_id WITH =, period WITH &&) WHERE (state <> 'voided')
);
CREATE INDEX billing_periods_invoice ON billing_periods (invoice_id);
CREATE INDEX billing_periods_rebill ON billing_periods (subscription_id) WHERE state = 'voided' AND replaced_by IS NULL;

CREATE TABLE invoice_sequences (
  fy text PRIMARY KEY,
  last_serial int NOT NULL DEFAULT 0
);

CREATE TABLE discount_redemptions (
  id bigserial PRIMARY KEY,
  discount_id bigint NOT NULL REFERENCES discounts,
  invoice_id bigint NOT NULL REFERENCES invoices ON DELETE CASCADE,
  subscription_id bigint NOT NULL REFERENCES subscriptions,
  amount bigint NOT NULL,
  released_on date,
  UNIQUE (discount_id, invoice_id)
);
CREATE INDEX discount_redemptions_discount ON discount_redemptions (discount_id) WHERE released_on IS NULL;

CREATE TABLE bank_statements (
  id bigserial PRIMARY KEY,
  filename text NOT NULL,
  source text NOT NULL,
  uploaded_by text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  line_count int NOT NULL DEFAULT 0
);

CREATE TABLE bank_lines (
  id bigserial PRIMARY KEY,
  statement_id bigint NOT NULL REFERENCES bank_statements ON DELETE CASCADE,
  txn_date date NOT NULL,
  description text NOT NULL,
  amount bigint NOT NULL,
  -- A statement uploaded twice must not post twice.
  fingerprint text NOT NULL UNIQUE,
  status bank_line_status NOT NULL DEFAULT 'unmatched',
  candidates jsonb NOT NULL DEFAULT '[]',
  confidence numeric(4,3),
  reason text,
  ai_note text,
  payment_id bigint
);
CREATE INDEX bank_lines_statement ON bank_lines (statement_id, id);

CREATE TABLE payer_aliases (
  alias citext PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers,
  learned_from text
);

CREATE TABLE payments (
  id bigserial PRIMARY KEY,
  number text NOT NULL UNIQUE,
  customer_id bigint NOT NULL REFERENCES customers,
  method payment_method NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  paid_on date NOT NULL,
  note text,
  reference text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bank', 'portal', 'import')),
  bank_line_id bigint REFERENCES bank_lines,
  created_by text NOT NULL DEFAULT 'Keel',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_customer ON payments (customer_id, paid_on DESC);
CREATE INDEX payments_paid_on ON payments (paid_on DESC, id DESC);

CREATE TABLE payment_allocations (
  id bigserial PRIMARY KEY,
  payment_id bigint NOT NULL REFERENCES payments ON DELETE CASCADE,
  invoice_id bigint NOT NULL REFERENCES invoices,
  amount bigint NOT NULL CHECK (amount > 0),
  UNIQUE (payment_id, invoice_id)
);
CREATE INDEX payment_allocations_invoice ON payment_allocations (invoice_id);

-- Every change in MRR is one row, so the revenue bridge reconciles by construction.
CREATE TABLE mrr_movements (
  id bigserial PRIMARY KEY,
  on_date date NOT NULL,
  subscription_id bigint NOT NULL REFERENCES subscriptions,
  customer_id bigint NOT NULL REFERENCES customers,
  plan_id bigint NOT NULL REFERENCES plans,
  kind mrr_kind NOT NULL,
  delta bigint NOT NULL
);
CREATE INDEX mrr_movements_date ON mrr_movements (on_date);
CREATE INDEX mrr_movements_plan ON mrr_movements (plan_id, on_date);

CREATE TABLE dunning_events (
  id bigserial PRIMARY KEY,
  invoice_id bigint NOT NULL REFERENCES invoices,
  step int NOT NULL,
  on_date date NOT NULL,
  actor text NOT NULL DEFAULT 'Keel',
  UNIQUE (invoice_id, step)
);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  kind text NOT NULL,
  on_date date NOT NULL,
  status text NOT NULL DEFAULT 'logged',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_recent ON outbox (id DESC);

-- Append-only and hash-chained: each row's hash covers the previous row's hash,
-- so editing history breaks the chain and the integrity page shows where.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  hash text NOT NULL
);

CREATE TABLE audit_head (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hash text NOT NULL DEFAULT 'genesis'
);
INSERT INTO audit_head DEFAULT VALUES;

CREATE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head text;
BEGIN
  SELECT hash INTO head FROM audit_head WHERE id = 1 FOR UPDATE;
  NEW.prev_hash := head;
  NEW.at := date_trunc('milliseconds', NEW.at);
  NEW.hash := encode(sha256(convert_to(
    head || '|' || NEW.actor || '|' || NEW.action || '|' || NEW.entity || '|' || coalesce(NEW.entity_id, '') || '|' || NEW.detail::text,
    'UTF8')), 'hex');
  UPDATE audit_head SET hash = NEW.hash WHERE id = 1;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_chain_before BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_chain();

CREATE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The audit log is append-only' USING ERRCODE = 'KE001';
END $$;
CREATE TRIGGER audit_no_rewrite BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_append_only();

-- A confirmed invoice is a legal document. Its figures can never change; corrections
-- go through cancellation and a new invoice.
CREATE FUNCTION invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
    NEW.subtotal, NEW.discount, NEW.taxable, NEW.tax, NEW.total, NEW.customer_id, NEW.subscription_id,
    NEW.issue_date, NEW.period_start, NEW.period_end, NEW.number
  ) IS DISTINCT FROM (
    OLD.subtotal, OLD.discount, OLD.taxable, OLD.tax, OLD.total, OLD.customer_id, OLD.subscription_id,
    OLD.issue_date, OLD.period_start, OLD.period_end, OLD.number
  ) THEN
    RAISE EXCEPTION 'Invoice % is confirmed and cannot be changed', OLD.number USING ERRCODE = 'KE002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_immutable BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_guard();

CREATE FUNCTION invoice_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state invoice_status;
BEGIN
  SELECT status INTO state FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Lines of a confirmed invoice cannot be changed' USING ERRCODE = 'KE002';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER invoice_lines_immutable BEFORE UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard();

-- Paid status is derived from allocations, in the database, so the two cannot disagree.
CREATE FUNCTION apply_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv invoices%ROWTYPE;
DECLARE paid_date date;
BEGIN
  SELECT * INTO inv FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
  IF inv.status NOT IN ('confirmed') THEN
    RAISE EXCEPTION 'Only a confirmed invoice with money still owed can take a payment' USING ERRCODE = 'KE003';
  END IF;
  IF inv.amount_paid + NEW.amount > inv.total THEN
    RAISE EXCEPTION 'Payment of % exceeds the % still owed on %', NEW.amount, inv.total - inv.amount_paid, inv.number USING ERRCODE = 'KE004';
  END IF;
  SELECT paid_on INTO paid_date FROM payments WHERE id = NEW.payment_id;
  UPDATE invoices
     SET amount_paid = amount_paid + NEW.amount,
         status = CASE WHEN amount_paid + NEW.amount = total THEN 'paid'::invoice_status ELSE status END,
         paid_on = CASE WHEN amount_paid + NEW.amount = total THEN paid_date ELSE paid_on END
   WHERE id = NEW.invoice_id;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_allocations_apply AFTER INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION apply_allocation();
