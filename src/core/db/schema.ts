/**
 * Database schema — forward-only migrations.
 *
 * Rules:
 *  - Tables are STRICT and money is stored as INTEGER paisa (`*_paisa`).
 *  - Timestamps are ISO-8601 UTC TEXT; business dates are `YYYY-MM-DD` TEXT.
 *  - Clinical/financial rows are soft-deleted (`deleted_at`) so history survives.
 *  - Foreign keys use RESTRICT for clinical links (never silently destroy patient
 *    history) and CASCADE only for owned child rows.
 *  - Every migration is idempotent and runs inside a transaction.
 */

export interface Migration {
  readonly id: string;
  readonly name: string;
  readonly sql: string;
}

const BASELINE_SQL = /* sql */ `
-- ===========================================================================
-- Meta
-- ===========================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
) STRICT;

-- ===========================================================================
-- Clinic, settings, activation, setup
-- ===========================================================================
CREATE TABLE IF NOT EXISTS clinic (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  name                TEXT NOT NULL,
  logo_path           TEXT,
  address             TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  email               TEXT NOT NULL DEFAULT '',
  website             TEXT NOT NULL DEFAULT '',
  clinic_message      TEXT NOT NULL DEFAULT '',
  visiting_hours      TEXT NOT NULL DEFAULT '',
  registration_number TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS activation (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  activated_at TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  machine_hash TEXT NOT NULL,
  signature    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS setup_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  activation_complete      INTEGER NOT NULL DEFAULT 0,
  clinic_complete          INTEGER NOT NULL DEFAULT 0,
  dentists_complete        INTEGER NOT NULL DEFAULT 0,
  preferences_complete     INTEGER NOT NULL DEFAULT 0,
  administrator_complete   INTEGER NOT NULL DEFAULT 0,
  review_complete          INTEGER NOT NULL DEFAULT 0,
  completed_step           INTEGER NOT NULL DEFAULT 0,
  completed_at             TEXT,
  draft_json               TEXT NOT NULL DEFAULT '{}'
) STRICT;

-- ===========================================================================
-- Identity, roles, staff, dentists
-- ===========================================================================
CREATE TABLE IF NOT EXISTS users (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  username                TEXT NOT NULL,
  password_hash           TEXT NOT NULL,
  full_name               TEXT NOT NULL DEFAULT '',
  email                   TEXT NOT NULL DEFAULT '',
  phone                   TEXT NOT NULL DEFAULT '',
  is_active               INTEGER NOT NULL DEFAULT 1,
  must_change_password    INTEGER NOT NULL DEFAULT 0,
  failed_attempts         INTEGER NOT NULL DEFAULT 0,
  locked_until            TEXT,
  last_login_at           TEXT,
  last_password_change_at TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  deleted_reason          TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (lower(username)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_active ON users (is_active) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_key ON roles (key) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_key)
) STRICT;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
) STRICT;

CREATE TABLE IF NOT EXISTS login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL,
  success      INTEGER NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  attempted_at TEXT NOT NULL,
  machine      TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts (attempted_at);

CREATE TABLE IF NOT EXISTS dentists (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  phone               TEXT NOT NULL DEFAULT '',
  email               TEXT NOT NULL DEFAULT '',
  photo_path          TEXT,
  signature_path      TEXT,
  registration_number TEXT NOT NULL DEFAULT '',
  visiting_hours      TEXT NOT NULL DEFAULT '',
  is_active           INTEGER NOT NULL DEFAULT 1,
  is_default          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_dentists_active ON dentists (is_active) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS dentist_credentials (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  dentist_id           INTEGER NOT NULL REFERENCES dentists (id) ON DELETE CASCADE,
  type                 TEXT NOT NULL CHECK (type IN ('designation', 'qualification', 'certification')),
  title                TEXT NOT NULL,
  institution          TEXT NOT NULL DEFAULT '',
  year                 INTEGER,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  show_on_prescription INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX IF NOT EXISTS idx_dentist_credentials_dentist ON dentist_credentials (dentist_id, type, sort_order);

CREATE TABLE IF NOT EXISTS staff (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  designation  TEXT NOT NULL DEFAULT '',
  department   TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  dob          TEXT,
  blood_group  TEXT NOT NULL DEFAULT 'unknown',
  national_id  TEXT NOT NULL DEFAULT '',
  photo_path   TEXT,
  salary_paisa INTEGER,
  joining_date TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_leave', 'resigned')),
  notes        TEXT NOT NULL DEFAULT '',
  user_id      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_staff_status ON staff (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_staff_department ON staff (department);

-- ===========================================================================
-- Patients
-- ===========================================================================
CREATE TABLE IF NOT EXISTS patient_tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  colour     TEXT NOT NULL DEFAULT '#64748b',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_patient_tags_name ON patient_tags (lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS referral_doctors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  specialty    TEXT NOT NULL DEFAULT '',
  organisation TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  address      TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_referral_doctors_name ON referral_doctors (name);

CREATE TABLE IF NOT EXISTS patients (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  code                   TEXT NOT NULL,
  first_name             TEXT NOT NULL,
  last_name              TEXT NOT NULL DEFAULT '',
  gender                 TEXT NOT NULL CHECK (gender IN ('male', 'female', 'other')),
  dob                    TEXT,
  age_years              INTEGER CHECK (age_years IS NULL OR (age_years >= 0 AND age_years <= 150)),
  blood_group            TEXT NOT NULL DEFAULT 'unknown',
  phone                  TEXT NOT NULL DEFAULT '',
  alternate_phone        TEXT NOT NULL DEFAULT '',
  email                  TEXT NOT NULL DEFAULT '',
  address                TEXT NOT NULL DEFAULT '',
  city                   TEXT NOT NULL DEFAULT '',
  emergency_contact_name TEXT NOT NULL DEFAULT '',
  emergency_phone        TEXT NOT NULL DEFAULT '',
  chief_complaint        TEXT NOT NULL DEFAULT '',
  previous_problems      TEXT NOT NULL DEFAULT '',
  medical_notes          TEXT NOT NULL DEFAULT '',
  allergies              TEXT NOT NULL DEFAULT '',
  notes                  TEXT NOT NULL DEFAULT '',
  preferred_contact      TEXT NOT NULL DEFAULT 'mobile',
  status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  referred_by            TEXT NOT NULL DEFAULT '',
  referred_by_doctor_id  INTEGER REFERENCES referral_doctors (id) ON DELETE SET NULL,
  created_by             INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  deleted_at             TEXT,
  deleted_reason         TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_code ON patients (code);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients (phone);
CREATE INDEX IF NOT EXISTS idx_patients_alternate_phone ON patients (alternate_phone);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients (lower(last_name), lower(first_name));
CREATE INDEX IF NOT EXISTS idx_patients_status ON patients (status);
CREATE INDEX IF NOT EXISTS idx_patients_created_at ON patients (created_at);
CREATE INDEX IF NOT EXISTS idx_patients_registration ON patients (substr(created_at, 1, 10));
CREATE INDEX IF NOT EXISTS idx_patients_deleted ON patients (deleted_at);

CREATE TABLE IF NOT EXISTS patient_contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('alternate_phone', 'phone', 'email', 'emergency', 'guardian')),
  name       TEXT NOT NULL DEFAULT '',
  relation   TEXT NOT NULL DEFAULT '',
  value      TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS idx_patient_contacts_patient ON patient_contacts (patient_id);

CREATE TABLE IF NOT EXISTS patient_tag_links (
  patient_id INTEGER NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES patient_tags (id) ON DELETE CASCADE,
  PRIMARY KEY (patient_id, tag_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_patient_tag_links_tag ON patient_tag_links (tag_id);

-- ===========================================================================
-- Attachments
-- ===========================================================================
CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL,
  entity_id     INTEGER NOT NULL,
  patient_id    INTEGER REFERENCES patients (id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  extension     TEXT NOT NULL DEFAULT '',
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'other',
  description   TEXT NOT NULL DEFAULT '',
  uploaded_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_attachments_patient ON attachments (patient_id);

-- ===========================================================================
-- Clinical: visits, treatments, dental chart
-- ===========================================================================
CREATE TABLE IF NOT EXISTS visits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  dentist_id     INTEGER REFERENCES dentists (id) ON DELETE SET NULL,
  visit_date     TEXT NOT NULL,
  visit_time     TEXT NOT NULL,
  chief_complaint TEXT NOT NULL DEFAULT '',
  history        TEXT NOT NULL DEFAULT '',
  examination    TEXT NOT NULL DEFAULT '',
  diagnosis      TEXT NOT NULL DEFAULT '',
  advice         TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  follow_up_date TEXT,
  cc_options     TEXT NOT NULL DEFAULT '[]',
  oe_options     TEXT NOT NULL DEFAULT '[]',
  re_options     TEXT NOT NULL DEFAULT '[]',
  advice_options TEXT NOT NULL DEFAULT '[]',
  created_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  deleted_reason TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits (patient_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_visits_date ON visits (visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_visits_dentist ON visits (dentist_id);
CREATE INDEX IF NOT EXISTS idx_visits_follow_up ON visits (follow_up_date);

CREATE TABLE IF NOT EXISTS treatment_catalog (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  price_paisa      INTEGER NOT NULL DEFAULT 0 CHECK (price_paisa >= 0),
  duration_minutes INTEGER NOT NULL DEFAULT 30 CHECK (duration_minutes >= 0),
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_treatment_catalog_code ON treatment_catalog (lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_treatment_catalog_name ON treatment_catalog (lower(name));
CREATE INDEX IF NOT EXISTS idx_treatment_catalog_category ON treatment_catalog (category);

CREATE TABLE IF NOT EXISTS treatment_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id          INTEGER NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  visit_id            INTEGER REFERENCES visits (id) ON DELETE SET NULL,
  treatment_id        INTEGER REFERENCES treatment_catalog (id) ON DELETE SET NULL,
  code                TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  tooth_codes         TEXT NOT NULL DEFAULT '[]',
  quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_paisa    INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_paisa >= 0),
  discount_paisa      INTEGER NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  total_paisa         INTEGER NOT NULL DEFAULT 0 CHECK (total_paisa >= 0),
  dentist_id          INTEGER REFERENCES dentists (id) ON DELETE SET NULL,
  performed_at        TEXT NOT NULL,
  invoice_item_id     INTEGER,
  notes               TEXT NOT NULL DEFAULT '',
  created_by          INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  deleted_at          TEXT,
  deleted_reason      TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_treatment_records_patient ON treatment_records (patient_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_treatment_records_visit ON treatment_records (visit_id);
CREATE INDEX IF NOT EXISTS idx_treatment_records_treatment ON treatment_records (treatment_id);

CREATE TABLE IF NOT EXISTS treatment_plans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  notes      TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_treatment_plans_patient ON treatment_plans (patient_id, status);

CREATE TABLE IF NOT EXISTS treatment_plan_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id           INTEGER NOT NULL REFERENCES treatment_plans (id) ON DELETE CASCADE,
  treatment_id      INTEGER REFERENCES treatment_catalog (id) ON DELETE SET NULL,
  description       TEXT NOT NULL DEFAULT '',
  tooth_codes       TEXT NOT NULL DEFAULT '[]',
  session_number    INTEGER NOT NULL DEFAULT 1 CHECK (session_number > 0),
  estimated_paisa   INTEGER NOT NULL DEFAULT 0 CHECK (estimated_paisa >= 0),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  notes             TEXT NOT NULL DEFAULT '',
  completed_visit_id INTEGER REFERENCES visits (id) ON DELETE SET NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS idx_treatment_plan_items_plan ON treatment_plan_items (plan_id, sort_order);

CREATE TABLE IF NOT EXISTS dental_charts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id       INTEGER NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  dentition        TEXT NOT NULL CHECK (dentition IN ('permanent', 'primary')),
  numbering_system TEXT NOT NULL DEFAULT 'fdi',
  updated_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  updated_at       TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dental_charts_patient ON dental_charts (patient_id, dentition);

CREATE TABLE IF NOT EXISTS tooth_findings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id     INTEGER NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  chart_id       INTEGER NOT NULL REFERENCES dental_charts (id) ON DELETE CASCADE,
  tooth_fdi      TEXT NOT NULL,
  finding        TEXT NOT NULL,
  surfaces       TEXT NOT NULL DEFAULT '[]',
  mobility_grade INTEGER NOT NULL DEFAULT 0 CHECK (mobility_grade BETWEEN 0 AND 3),
  note           TEXT NOT NULL DEFAULT '',
  visit_id       INTEGER REFERENCES visits (id) ON DELETE SET NULL,
  recorded_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  recorded_at    TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX IF NOT EXISTS idx_tooth_findings_patient ON tooth_findings (patient_id, is_active);
CREATE INDEX IF NOT EXISTS idx_tooth_findings_tooth ON tooth_findings (patient_id, tooth_fdi);
CREATE INDEX IF NOT EXISTS idx_tooth_findings_chart ON tooth_findings (chart_id);

CREATE TABLE IF NOT EXISTS perio_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id  INTEGER NOT NULL REFERENCES patients (id) ON DELETE CASCADE,
  tooth_fdi   TEXT NOT NULL,
  site        TEXT NOT NULL,
  depth_mm    INTEGER NOT NULL CHECK (depth_mm >= 0 AND depth_mm <= 15),
  recorded_at TEXT NOT NULL,
  recorded_by INTEGER REFERENCES users (id) ON DELETE SET NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_perio_records_patient ON perio_records (patient_id, tooth_fdi);

-- ===========================================================================
-- Prescriptions
-- ===========================================================================
CREATE TABLE IF NOT EXISTS medications (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  form                 TEXT NOT NULL DEFAULT 'tablet',
  strength             TEXT NOT NULL DEFAULT '',
  default_dose_morning INTEGER NOT NULL DEFAULT 0 CHECK (default_dose_morning BETWEEN 0 AND 10),
  default_dose_noon    INTEGER NOT NULL DEFAULT 0 CHECK (default_dose_noon BETWEEN 0 AND 10),
  default_dose_night   INTEGER NOT NULL DEFAULT 0 CHECK (default_dose_night BETWEEN 0 AND 10),
  default_food_timing  TEXT NOT NULL DEFAULT 'after_food',
  default_duration_days INTEGER,
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_medications_name ON medications (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_medications_unique ON medications (lower(name), lower(form), lower(strength)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS clinical_options (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  category   TEXT NOT NULL CHECK (category IN ('cc', 'oe', 're', 'advice')),
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clinical_options_unique ON clinical_options (category, lower(label)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_clinical_options_category ON clinical_options (category, sort_order);

CREATE TABLE IF NOT EXISTS prescriptions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  number           TEXT NOT NULL,
  patient_id       INTEGER NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  dentist_id       INTEGER REFERENCES dentists (id) ON DELETE SET NULL,
  visit_id         INTEGER REFERENCES visits (id) ON DELETE SET NULL,
  date             TEXT NOT NULL,
  cc               TEXT NOT NULL DEFAULT '[]',
  oe               TEXT NOT NULL DEFAULT '[]',
  re               TEXT NOT NULL DEFAULT '[]',
  advice           TEXT NOT NULL DEFAULT '[]',
  notes            TEXT NOT NULL DEFAULT '',
  is_void          INTEGER NOT NULL DEFAULT 0,
  void_reason      TEXT NOT NULL DEFAULT '',
  voided_at        TEXT,
  voided_by        INTEGER REFERENCES users (id) ON DELETE SET NULL,
  printed_at       TEXT,
  print_count      INTEGER NOT NULL DEFAULT 0,
  superseded_by_id INTEGER REFERENCES prescriptions (id) ON DELETE SET NULL,
  created_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  deleted_reason   TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_prescriptions_number ON prescriptions (number);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient ON prescriptions (patient_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_prescriptions_dentist ON prescriptions (dentist_id);

CREATE TABLE IF NOT EXISTS prescription_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  prescription_id INTEGER NOT NULL REFERENCES prescriptions (id) ON DELETE CASCADE,
  medication_id  INTEGER REFERENCES medications (id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  form           TEXT NOT NULL DEFAULT 'tablet',
  strength       TEXT NOT NULL DEFAULT '',
  dose_morning   INTEGER NOT NULL DEFAULT 0 CHECK (dose_morning BETWEEN 0 AND 10),
  dose_noon      INTEGER NOT NULL DEFAULT 0 CHECK (dose_noon BETWEEN 0 AND 10),
  dose_night     INTEGER NOT NULL DEFAULT 0 CHECK (dose_night BETWEEN 0 AND 10),
  food_timing    TEXT NOT NULL DEFAULT 'after_food',
  duration_days  INTEGER CHECK (duration_days IS NULL OR duration_days > 0),
  quantity       INTEGER CHECK (quantity IS NULL OR quantity > 0),
  instructions   TEXT NOT NULL DEFAULT '',
  sort_order     INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS idx_prescription_items_prescription ON prescription_items (prescription_id, sort_order);

-- ===========================================================================
-- Appointments & queue
-- ===========================================================================
CREATE TABLE IF NOT EXISTS appointments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id          INTEGER NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  dentist_id          INTEGER REFERENCES dentists (id) ON DELETE SET NULL,
  date                TEXT NOT NULL,
  start_time          TEXT NOT NULL,
  end_time            TEXT NOT NULL,
  reason              TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'scheduled',
  reminder_note       TEXT NOT NULL DEFAULT '',
  cancelled_reason    TEXT NOT NULL DEFAULT '',
  rescheduled_from_id INTEGER REFERENCES appointments (id) ON DELETE SET NULL,
  visit_id            INTEGER REFERENCES visits (id) ON DELETE SET NULL,
  created_by          INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments (date, start_time);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments (patient_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_dentist ON appointments (dentist_id, date);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_slot ON appointments (dentist_id, date, start_time) WHERE deleted_at IS NULL AND status NOT IN ('cancelled', 'no_show');

CREATE TABLE IF NOT EXISTS queue_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT NOT NULL,
  queue_number   INTEGER NOT NULL,
  patient_id     INTEGER NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  appointment_id INTEGER REFERENCES appointments (id) ON DELETE SET NULL,
  dentist_id     INTEGER REFERENCES dentists (id) ON DELETE SET NULL,
  arrival_time   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'called', 'in_consultation', 'completed', 'cancelled')),
  priority       TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  notes          TEXT NOT NULL DEFAULT '',
  called_at      TEXT,
  started_at     TEXT,
  completed_at   TEXT,
  visit_id       INTEGER REFERENCES visits (id) ON DELETE SET NULL,
  created_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_entries_number ON queue_entries (date, queue_number);
CREATE INDEX IF NOT EXISTS idx_queue_entries_date ON queue_entries (date, status);

-- ===========================================================================
-- Billing
-- ===========================================================================
CREATE TABLE IF NOT EXISTS payment_methods (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT NOT NULL,
  name                TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'other',
  requires_reference  INTEGER NOT NULL DEFAULT 0,
  is_active           INTEGER NOT NULL DEFAULT 1,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_code ON payment_methods (lower(code)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT NOT NULL,
  patient_id     INTEGER NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  visit_id       INTEGER REFERENCES visits (id) ON DELETE SET NULL,
  dentist_id     INTEGER REFERENCES dentists (id) ON DELETE SET NULL,
  date           TEXT NOT NULL,
  subtotal_paisa INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_paisa >= 0),
  discount_paisa INTEGER NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  discount_type  TEXT NOT NULL DEFAULT 'none',
  discount_value INTEGER NOT NULL DEFAULT 0,
  total_paisa    INTEGER NOT NULL DEFAULT 0 CHECK (total_paisa >= 0),
  paid_paisa     INTEGER NOT NULL DEFAULT 0 CHECK (paid_paisa >= 0),
  status         TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'partially_paid', 'paid', 'void')),
  notes          TEXT NOT NULL DEFAULT '',
  is_void        INTEGER NOT NULL DEFAULT 0,
  void_reason    TEXT NOT NULL DEFAULT '',
  voided_at      TEXT,
  voided_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  deleted_reason TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices (number);
CREATE INDEX IF NOT EXISTS idx_invoices_patient ON invoices (patient_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices (date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);

CREATE TABLE IF NOT EXISTS invoice_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id          INTEGER NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  treatment_id        INTEGER REFERENCES treatment_catalog (id) ON DELETE SET NULL,
  treatment_record_id INTEGER REFERENCES treatment_records (id) ON DELETE SET NULL,
  code                TEXT NOT NULL DEFAULT '',
  description         TEXT NOT NULL DEFAULT '',
  tooth_codes         TEXT NOT NULL DEFAULT '[]',
  quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_paisa    INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_paisa >= 0),
  discount_type       TEXT NOT NULL DEFAULT 'none',
  discount_value      INTEGER NOT NULL DEFAULT 0,
  discount_paisa      INTEGER NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  line_total_paisa    INTEGER NOT NULL DEFAULT 0 CHECK (line_total_paisa >= 0),
  sort_order          INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id, sort_order);

CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number TEXT NOT NULL,
  invoice_id     INTEGER NOT NULL REFERENCES invoices (id) ON DELETE RESTRICT,
  patient_id     INTEGER NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  amount_paisa   INTEGER NOT NULL CHECK (amount_paisa > 0),
  method_id      INTEGER REFERENCES payment_methods (id) ON DELETE SET NULL,
  reference      TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  paid_at        TEXT NOT NULL,
  paid_date      TEXT NOT NULL,
  received_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  is_void        INTEGER NOT NULL DEFAULT 0,
  void_reason    TEXT NOT NULL DEFAULT '',
  voided_at      TEXT,
  voided_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_receipt ON payments (receipt_number);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_patient ON payments (patient_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments (paid_date);

-- ===========================================================================
-- Inventory
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inventory_categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_categories_name ON inventory_categories (lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS suppliers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  contact_person TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  address        TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers (lower(name));

CREATE TABLE IF NOT EXISTS inventory_items (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  code                   TEXT NOT NULL,
  name                   TEXT NOT NULL,
  category_id            INTEGER REFERENCES inventory_categories (id) ON DELETE SET NULL,
  supplier_id            INTEGER REFERENCES suppliers (id) ON DELETE SET NULL,
  unit                   TEXT NOT NULL DEFAULT 'piece',
  purchase_price_paisa   INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price_paisa >= 0),
  selling_price_paisa    INTEGER CHECK (selling_price_paisa IS NULL OR selling_price_paisa >= 0),
  current_stock_milli    INTEGER NOT NULL DEFAULT 0,
  minimum_stock_milli    INTEGER NOT NULL DEFAULT 0 CHECK (minimum_stock_milli >= 0),
  reorder_level_milli    INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level_milli >= 0),
  batch_number           TEXT NOT NULL DEFAULT '',
  expiry_date            TEXT,
  purchase_date          TEXT,
  storage_location       TEXT NOT NULL DEFAULT '',
  notes                  TEXT NOT NULL DEFAULT '',
  is_active              INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  deleted_at             TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_code ON inventory_items (lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_items_name ON inventory_items (lower(name));
CREATE INDEX IF NOT EXISTS idx_inventory_items_category ON inventory_items (category_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_supplier ON inventory_items (supplier_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_expiry ON inventory_items (expiry_date);

CREATE TABLE IF NOT EXISTS inventory_purchases (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  reference                 TEXT NOT NULL,
  supplier_id               INTEGER REFERENCES suppliers (id) ON DELETE SET NULL,
  date                      TEXT NOT NULL,
  invoice_number            TEXT NOT NULL DEFAULT '',
  subtotal_paisa            INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_paisa >= 0),
  discount_paisa            INTEGER NOT NULL DEFAULT 0 CHECK (discount_paisa >= 0),
  total_paisa               INTEGER NOT NULL DEFAULT 0 CHECK (total_paisa >= 0),
  paid_paisa                INTEGER NOT NULL DEFAULT 0 CHECK (paid_paisa >= 0),
  payment_method_id         INTEGER REFERENCES payment_methods (id) ON DELETE SET NULL,
  notes                     TEXT NOT NULL DEFAULT '',
  accounting_transaction_id INTEGER REFERENCES accounting_transactions (id) ON DELETE SET NULL,
  created_by                INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_purchases_reference ON inventory_purchases (reference);
CREATE INDEX IF NOT EXISTS idx_inventory_purchases_supplier ON inventory_purchases (supplier_id, date DESC);

CREATE TABLE IF NOT EXISTS inventory_purchase_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id     INTEGER NOT NULL REFERENCES inventory_purchases (id) ON DELETE CASCADE,
  item_id         INTEGER REFERENCES inventory_items (id) ON DELETE SET NULL,
  item_name       TEXT NOT NULL DEFAULT '',
  quantity_milli  INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_price_paisa INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_paisa >= 0),
  total_paisa     INTEGER NOT NULL DEFAULT 0 CHECK (total_paisa >= 0),
  batch_number    TEXT NOT NULL DEFAULT '',
  expiry_date     TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_inventory_purchase_items_purchase ON inventory_purchase_items (purchase_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id             INTEGER NOT NULL REFERENCES inventory_items (id) ON DELETE RESTRICT,
  type                TEXT NOT NULL,
  quantity_milli      INTEGER NOT NULL,
  balance_after_milli INTEGER NOT NULL,
  unit_cost_paisa     INTEGER,
  reason              TEXT NOT NULL DEFAULT '',
  reference           TEXT NOT NULL DEFAULT '',
  related_purchase_id INTEGER REFERENCES inventory_purchases (id) ON DELETE SET NULL,
  related_visit_id    INTEGER REFERENCES visits (id) ON DELETE SET NULL,
  batch_number        TEXT NOT NULL DEFAULT '',
  expiry_date         TEXT,
  moved_at            TEXT NOT NULL,
  moved_date          TEXT NOT NULL,
  moved_by            INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  is_reversed         INTEGER NOT NULL DEFAULT 0,
  reversed_by_id      INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements (item_id, moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements (moved_date);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type ON stock_movements (type);

-- ===========================================================================
-- Accounting
-- ===========================================================================
CREATE TABLE IF NOT EXISTS accounting_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  is_active  INTEGER NOT NULL DEFAULT 1,
  is_system  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_categories_name ON accounting_categories (lower(name), direction) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS financial_periods (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  is_closed    INTEGER NOT NULL DEFAULT 0,
  closed_at    TEXT,
  closed_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_periods_range ON financial_periods (period_start, period_end);

CREATE TABLE IF NOT EXISTS accounting_transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  direction         TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  date              TEXT NOT NULL,
  category_id       INTEGER NOT NULL REFERENCES accounting_categories (id) ON DELETE RESTRICT,
  amount_paisa      INTEGER NOT NULL CHECK (amount_paisa > 0),
  payment_method_id INTEGER REFERENCES payment_methods (id) ON DELETE SET NULL,
  reference         TEXT NOT NULL DEFAULT '',
  note              TEXT NOT NULL DEFAULT '',
  source_type       TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('manual', 'payment', 'invoice_void', 'purchase', 'payroll', 'opening')),
  source_id         INTEGER,
  is_void           INTEGER NOT NULL DEFAULT 0,
  void_reason       TEXT NOT NULL DEFAULT '',
  voided_at         TEXT,
  voided_by         INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_by        INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_accounting_transactions_date ON accounting_transactions (date DESC);
CREATE INDEX IF NOT EXISTS idx_accounting_transactions_category ON accounting_transactions (category_id);
CREATE INDEX IF NOT EXISTS idx_accounting_transactions_source ON accounting_transactions (source_type, source_id);

-- ===========================================================================
-- Notifications, audit, backups, printing, system events
-- ===========================================================================
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'info',
  title         TEXT NOT NULL,
  message       TEXT NOT NULL DEFAULT '',
  entity_type   TEXT NOT NULL DEFAULT '',
  entity_id     INTEGER,
  target_screen TEXT NOT NULL DEFAULT '',
  target_id     INTEGER,
  dedupe_key    TEXT NOT NULL,
  is_read       INTEGER NOT NULL DEFAULT 0,
  is_dismissed  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  read_at       TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (is_read, is_dismissed, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   INTEGER,
  entity_label TEXT NOT NULL DEFAULT '',
  user_id     INTEGER,
  user_name   TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  before_json TEXT,
  after_json  TEXT,
  context_json TEXT,
  session_id  TEXT NOT NULL DEFAULT '',
  machine     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backup_records (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name        TEXT NOT NULL,
  file_path        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  kind             TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'automatic', 'pre_restore')),
  status           TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'in_progress')),
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  created_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  app_version      TEXT NOT NULL DEFAULT '',
  schema_version   INTEGER NOT NULL DEFAULT 0,
  patient_count    INTEGER NOT NULL DEFAULT 0,
  invoice_count    INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  checksum         TEXT NOT NULL DEFAULT '',
  verified_at      TEXT,
  failure_message  TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX IF NOT EXISTS idx_backup_records_time ON backup_records (created_at DESC);

CREATE TABLE IF NOT EXISTS printer_profiles (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('prescription', 'invoice', 'report', 'patient_summary')),
  printer_name   TEXT NOT NULL DEFAULT '',
  paper_key      TEXT NOT NULL DEFAULT 'a4',
  width_mm       REAL NOT NULL DEFAULT 210,
  height_mm      REAL NOT NULL DEFAULT 297,
  orientation    TEXT NOT NULL DEFAULT 'portrait' CHECK (orientation IN ('portrait', 'landscape')),
  margin_top_mm  REAL NOT NULL DEFAULT 12,
  margin_right_mm REAL NOT NULL DEFAULT 12,
  margin_bottom_mm REAL NOT NULL DEFAULT 12,
  margin_left_mm REAL NOT NULL DEFAULT 12,
  scale_percent  INTEGER NOT NULL DEFAULT 100 CHECK (scale_percent BETWEEN 50 AND 200),
  copies         INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 10),
  is_thermal     INTEGER NOT NULL DEFAULT 0,
  is_default     INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  header_note    TEXT NOT NULL DEFAULT '',
  footer_note    TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_printer_profiles_kind ON printer_profiles (kind, is_active);

CREATE TABLE IF NOT EXISTS print_templates (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                      TEXT NOT NULL CHECK (kind IN ('prescription', 'invoice', 'report', 'patient_summary')),
  name                      TEXT NOT NULL,
  header_text               TEXT NOT NULL DEFAULT '',
  footer_text               TEXT NOT NULL DEFAULT '',
  show_logo                 INTEGER NOT NULL DEFAULT 1,
  show_dentist_signature    INTEGER NOT NULL DEFAULT 1,
  show_dentist_qualifications INTEGER NOT NULL DEFAULT 1,
  signature_label           TEXT NOT NULL DEFAULT 'Signature',
  accent_colour             TEXT NOT NULL DEFAULT '#0B2545',
  is_default                INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_print_templates_kind ON print_templates (kind, is_default);

CREATE TABLE IF NOT EXISTS system_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  detail_json TEXT,
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_system_events_time ON system_events (created_at DESC);

-- ===========================================================================
-- Full-text search (FTS5) — kept in sync by triggers
-- ===========================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS patients_fts USING fts5 (
  code, name, phone, address,
  content='',
  contentless_delete=1,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS treatments_fts USING fts5 (
  code, name, category, description,
  content='',
  contentless_delete=1,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS medications_fts USING fts5 (
  name, strength,
  content='',
  contentless_delete=1,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS inventory_fts USING fts5 (
  code, name, batch,
  content='',
  contentless_delete=1,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

const MIGRATION_0002_INDEXES = /* sql */ `
-- Composite indices that help the busiest list screens stay fast with large data.
CREATE INDEX IF NOT EXISTS idx_visits_patient_date ON visits (patient_id, visit_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_patient_date ON invoices (patient_id, date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_active ON payments (invoice_id, is_void);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_date ON appointments (patient_id, date DESC, start_time);
CREATE INDEX IF NOT EXISTS idx_tooth_findings_visit ON tooth_findings (visit_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_date ON prescriptions (patient_id, date DESC, id DESC);
`;

const MIGRATION_0003_REFERRALS = /* sql */ `
-- Specialist referral records. The doctors directory lives in referral_doctors;
-- the record keeps a denormalised copy of the doctor's details so a referral
-- printed years ago still shows what was actually written.
CREATE TABLE IF NOT EXISTS referrals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id          INTEGER NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  visit_id            INTEGER REFERENCES visits (id) ON DELETE SET NULL,
  referral_doctor_id  INTEGER REFERENCES referral_doctors (id) ON DELETE SET NULL,
  doctor_name         TEXT NOT NULL,
  specialty           TEXT NOT NULL DEFAULT '',
  organisation        TEXT NOT NULL DEFAULT '',
  contact             TEXT NOT NULL DEFAULT '',
  reason              TEXT NOT NULL DEFAULT '',
  date                TEXT NOT NULL,
  follow_up_date      TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'completed', 'cancelled')),
  notes               TEXT NOT NULL DEFAULT '',
  created_by          INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_referrals_patient_date ON referrals (patient_id, date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals (status, date DESC);
`;

const MIGRATION_0004_SEARCH_TABLES = /* sql */ `
-- The search tables are contentless. contentless_delete=1 lets a row be
-- removed with an ordinary DELETE, which is what the services do when a record
-- is edited, removed or restored. The indexes are rebuilt from the source
-- tables so an upgraded installation keeps finding everything.
DROP TABLE IF EXISTS patients_fts;
CREATE VIRTUAL TABLE patients_fts USING fts5 (
  code, name, phone, address,
  content='',
  contentless_delete=1,
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO patients_fts (rowid, code, name, phone, address)
SELECT id, code, trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')),
       trim(coalesce(phone, '') || ' ' || coalesce(alternate_phone, '')), coalesce(address, '')
  FROM patients;

DROP TABLE IF EXISTS treatments_fts;
CREATE VIRTUAL TABLE treatments_fts USING fts5 (
  code, name, category, description,
  content='',
  contentless_delete=1,
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO treatments_fts (rowid, code, name, category, description)
SELECT id, code, name, coalesce(category, ''), coalesce(description, '')
  FROM treatment_catalog;

DROP TABLE IF EXISTS medications_fts;
CREATE VIRTUAL TABLE medications_fts USING fts5 (
  name, strength,
  content='',
  contentless_delete=1,
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO medications_fts (rowid, name, strength)
SELECT id, name, coalesce(strength, '') FROM medications;

DROP TABLE IF EXISTS inventory_fts;
CREATE VIRTUAL TABLE inventory_fts USING fts5 (
  code, name, batch,
  content='',
  contentless_delete=1,
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO inventory_fts (rowid, code, name, batch)
SELECT id, code, name, coalesce(batch_number, '') FROM inventory_items;
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: '0001_baseline', name: 'Initial schema', sql: BASELINE_SQL },
  { id: '0002_performance_indexes', name: 'Additional composite indices', sql: MIGRATION_0002_INDEXES },
  { id: '0003_referrals', name: 'Specialist referral records', sql: MIGRATION_0003_REFERRALS },
  { id: '0004_searchable_fts', name: 'Rebuild the search tables with contentless_delete', sql: MIGRATION_0004_SEARCH_TABLES },
];

/** Migration id applied to a brand new database (the baseline is the schema itself). */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/**
 * FTS maintenance statements. They are executed by the services after a write
 * (within the same transaction) rather than by SQL triggers, so the index can
 * be rebuilt deterministically and verified by the integrity check.
 */
export const FTS_TABLES = ['patients_fts', 'treatments_fts', 'medications_fts', 'inventory_fts'] as const;
export type FtsTable = (typeof FTS_TABLES)[number];
