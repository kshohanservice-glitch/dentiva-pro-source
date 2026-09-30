/**
 * Permission catalogue and default role presets.
 *
 * Permissions are the single source of truth for authorisation: the IPC router
 * checks them before a call reaches a service, and the services re-check them
 * for privileged operations. Hiding a menu item is never treated as security.
 */

export type PermissionGroup =
  | 'patients'
  | 'clinical'
  | 'appointments'
  | 'billing'
  | 'reports'
  | 'inventory'
  | 'accounting'
  | 'staff'
  | 'administration'
  | 'data';

export interface PermissionDefinition {
  readonly key: string;
  readonly group: PermissionGroup;
  readonly label: string;
  readonly description: string;
  /** Sensitive permissions are highlighted in the role editor. */
  readonly sensitive?: boolean;
}

export const PERMISSION_GROUP_LABELS: Readonly<Record<PermissionGroup, string>> = {
  patients: 'Patients',
  clinical: 'Clinical records',
  appointments: 'Appointments & queue',
  billing: 'Billing & payments',
  reports: 'Reports & analytics',
  inventory: 'Inventory',
  accounting: 'Accounting',
  staff: 'Staff & dentists',
  administration: 'Administration',
  data: 'Data & system',
};

export const PERMISSION_DEFINITIONS = [
  // --- Patients ------------------------------------------------------------
  { key: 'patient.view', group: 'patients', label: 'View patients', description: 'Open the patient list and patient profiles.' },
  { key: 'patient.create', group: 'patients', label: 'Register patients', description: 'Create new patient records.' },
  { key: 'patient.edit', group: 'patients', label: 'Edit patients', description: 'Change patient details and medical information.' },
  {
    key: 'patient.delete',
    group: 'patients',
    label: 'Delete' + ' patients',
    description: 'Remove patients from the active register.',
    sensitive: true,
  },
  {
    key: 'patient.export',
    group: 'patients',
    label: 'Export' + ' patients',
    description: 'Export patient lists and profiles.',
    sensitive: true,
  },
  {
    key: 'patient.attachment.view',
    group: 'patients',
    label: 'View' + ' attachments',
    description: 'Open radiographs, photographs and documents.',
  },
  {
    key: 'patient.attachment.manage',
    group: 'patients',
    label: 'Add / rename' + ' attachments',
    description: 'Upload and organise patient files.',
  },
  {
    key: 'patient.attachment.delete',
    group: 'patients',
    label: 'Delete' + ' attachments',
    description: 'Permanently remove patient files.',
    sensitive: true,
  },
  {
    key: 'patient.medical.view',
    group: 'patients',
    label: 'View medical' + ' notes',
    description: 'Read allergies, medical history and clinical notes.',
    sensitive: true,
  },

  // --- Clinical ------------------------------------------------------------
  { key: 'visit.view', group: 'clinical', label: 'View visits', description: 'Read visit history in full.' },
  { key: 'visit.create', group: 'clinical', label: 'Create visits', description: 'Record a new visit.' },
  { key: 'visit.edit', group: 'clinical', label: 'Edit visits', description: 'Amend the current visit record.' },
  { key: 'visit.delete', group: 'clinical', label: 'Delete visits', description: 'Remove a visit from history.', sensitive: true },
  { key: 'chart.view', group: 'clinical', label: 'View dental chart', description: 'Open dental charts and tooth history.' },
  { key: 'chart.edit', group: 'clinical', label: 'Edit dental chart', description: 'Record tooth findings and surfaces.' },
  { key: 'prescription.view', group: 'clinical', label: 'View prescriptions', description: 'Read prescriptions.' },
  { key: 'prescription.create', group: 'clinical', label: 'Create prescriptions', description: 'Prescribe medications.' },
  {
    key: 'prescription.edit',
    group: 'clinical',
    label: 'Edit' + ' prescriptions',
    description: 'Amend or supersede a prescription.',
    sensitive: true,
  },
  { key: 'prescription.delete', group: 'clinical', label: 'Delete prescriptions', description: 'Remove a prescription.', sensitive: true },
  { key: 'prescription.print', group: 'clinical', label: 'Print prescriptions', description: 'Print or export prescriptions as PDF.' },
  { key: 'treatment.view', group: 'clinical', label: 'View treatment catalog', description: 'Browse available treatments and prices.' },
  {
    key: 'treatment.manage',
    group: 'clinical',
    label: 'Manage treatment' + ' catalog',
    description: 'Add, edit and price treatments.',
    sensitive: true,
  },
  {
    key: 'clinical_option.manage',
    group: 'clinical',
    label: 'Manage clinical' + ' options',
    description: 'Maintain C/C, O/E, R/E and advice option lists.',
  },

  // --- Appointments & queue ------------------------------------------------
  { key: 'appointment.view', group: 'appointments', label: 'View appointments', description: 'See the appointment calendar.' },
  { key: 'appointment.create', group: 'appointments', label: 'Book appointments', description: 'Create appointments.' },
  { key: 'appointment.edit', group: 'appointments', label: 'Edit appointments', description: 'Reschedule or amend appointments.' },
  { key: 'appointment.delete', group: 'appointments', label: 'Delete appointments', description: 'Remove appointments.', sensitive: true },
  {
    key: 'appointment.status',
    group: 'appointments',
    label: 'Update appointment' + ' status',
    description: 'Mark arrivals, completion, no-shows.',
  },
  { key: 'queue.view', group: 'appointments', label: 'View queue', description: 'See today’s patient queue.' },
  { key: 'queue.manage', group: 'appointments', label: 'Manage queue', description: 'Call, start, complete or cancel queue entries.' },

  // --- Billing -------------------------------------------------------------
  { key: 'invoice.view', group: 'billing', label: 'View invoices', description: 'Open invoices and patient balances.' },
  { key: 'invoice.create', group: 'billing', label: 'Create invoices', description: 'Raise invoices for treatments and products.' },
  { key: 'invoice.edit', group: 'billing', label: 'Edit invoices', description: 'Change invoice items before payment.', sensitive: true },
  { key: 'invoice.delete', group: 'billing', label: 'Delete / void invoices', description: 'Void or remove invoices.', sensitive: true },
  { key: 'invoice.print', group: 'billing', label: 'Print invoices', description: 'Print or export invoices as PDF.' },
  {
    key: 'invoice.discount',
    group: 'billing',
    label: 'Apply' + ' discounts',
    description: 'Discount invoice lines and totals.',
    sensitive: true,
  },
  { key: 'payment.view', group: 'billing', label: 'View payments', description: 'Read payment records.' },
  { key: 'payment.create', group: 'billing', label: 'Record payments', description: 'Receive and record payments.' },
  { key: 'payment.edit', group: 'billing', label: 'Edit payments', description: 'Amend an existing payment.', sensitive: true },
  { key: 'payment.delete', group: 'billing', label: 'Delete payments', description: 'Reverse or remove payments.', sensitive: true },
  {
    key: 'payment_method.manage',
    group: 'billing',
    label: 'Manage payment' + ' methods',
    description: 'Configure cash, bank, card and wallet methods.',
    sensitive: true,
  },

  // --- Reports -------------------------------------------------------------
  {
    key: 'report.operational.view',
    group: 'reports',
    label: 'View operational' + ' reports',
    description: 'Patients, appointments, visits, treatments, inventory reports.',
  },
  {
    key: 'report.financial.view',
    group: 'reports',
    label: 'View financial' + ' reports',
    description: 'Revenue, collections and outstanding balances.',
    sensitive: true,
  },
  {
    key: 'report.profit.view',
    group: 'reports',
    label: 'View profit' + ' & expenses',
    description: 'Income versus expense analysis.',
    sensitive: true,
  },
  { key: 'report.export', group: 'reports', label: 'Export reports', description: 'Export or print report output.', sensitive: true },
  {
    key: 'search.use',
    group: 'administration',
    label: 'Use global' + ' search',
    description: 'Search patients, visits, invoices and the other records this role can open.',
  },
  {
    key: 'dashboard.view',
    group: 'reports',
    label: 'Open the' + ' dashboard',
    description: 'Landing screen with today\u2019s appointments, the queue and outstanding work.',
  },
  {
    key: 'dashboard.financial.view',
    group: 'reports',
    label: 'See financial' + ' dashboard widgets',
    description: 'Revenue and outstanding widgets on the dashboard.',
    sensitive: true,
  },

  // --- Inventory -----------------------------------------------------------
  { key: 'inventory.view', group: 'inventory', label: 'View inventory', description: 'Browse stock levels and history.' },
  {
    key: 'inventory.manage',
    group: 'inventory',
    label: 'Manage inventory' + ' items',
    description: 'Create and edit items, suppliers and categories.',
  },
  {
    key: 'inventory.purchase',
    group: 'inventory',
    label: 'Record' + ' purchases',
    description: 'Register supplier purchases and receive stock.',
  },
  {
    key: 'inventory.adjust',
    group: 'inventory',
    label: 'Adjust' + ' stock',
    description: 'Record consumption, damage, expiry and corrections.',
    sensitive: true,
  },
  {
    key: 'inventory.delete',
    group: 'inventory',
    label: 'Delete inventory' + ' records',
    description: 'Remove items, purchases and movements.',
    sensitive: true,
  },

  // --- Accounting ----------------------------------------------------------
  {
    key: 'accounting.view',
    group: 'accounting',
    label: 'View' + ' accounting',
    description: 'Income, expenses and ledger entries.',
    sensitive: true,
  },
  {
    key: 'accounting.manage',
    group: 'accounting',
    label: 'Manage accounting' + ' entries',
    description: 'Record and amend income and expenses.',
    sensitive: true,
  },
  {
    key: 'accounting.delete',
    group: 'accounting',
    label: 'Delete accounting' + ' entries',
    description: 'Remove ledger entries.',
    sensitive: true,
  },
  {
    key: 'accounting.category.manage',
    group: 'accounting',
    label: 'Manage accounting' + ' categories',
    description: 'Configure income and expense categories.',
  },
  {
    key: 'accounting.period.manage',
    group: 'accounting',
    label: 'Close accounting' + ' periods',
    description: 'Lock a period against further edits.',
    sensitive: true,
  },

  // --- Staff ---------------------------------------------------------------
  { key: 'staff.view', group: 'staff', label: 'View staff', description: 'Open the staff directory.' },
  { key: 'staff.manage', group: 'staff', label: 'Manage staff', description: 'Create and edit staff records.' },
  {
    key: 'staff.sensitive.view',
    group: 'staff',
    label: 'View staff' + ' salary & ID',
    description: 'Read salary and national ID details.',
    sensitive: true,
  },
  {
    key: 'dentist.view',
    group: 'staff',
    label: 'View' + ' dentists',
    description: 'See dentist profiles when booking appointments or writing prescriptions.',
  },
  {
    key: 'dentist.manage',
    group: 'staff',
    label: 'Manage' + ' dentists',
    description: 'Maintain dentist profiles, qualifications and signatures.',
  },

  // --- Administration ------------------------------------------------------
  { key: 'user.view', group: 'administration', label: 'View users', description: 'See the list of application users.' },
  {
    key: 'user.manage',
    group: 'administration',
    label: 'Manage' + ' users',
    description: 'Create users, reset passwords, assign roles.',
    sensitive: true,
  },
  {
    key: 'role.manage',
    group: 'administration',
    label: 'Manage roles &' + ' permissions',
    description: 'Create roles and change permissions.',
    sensitive: true,
  },
  { key: 'settings.view', group: 'administration', label: 'View settings', description: 'Open the settings centre.' },
  {
    key: 'settings.manage',
    group: 'administration',
    label: 'Manage' + ' settings',
    description: 'Change clinic, printing and security settings.',
    sensitive: true,
  },
  { key: 'backup.create', group: 'administration', label: 'Create backups', description: 'Run manual and automatic backups.' },
  {
    key: 'backup.restore',
    group: 'administration',
    label: 'Restore' + ' backups',
    description: 'Replace live data from a backup file.',
    sensitive: true,
  },
  { key: 'backup.manage', group: 'administration', label: 'Manage backup settings', description: 'Configure backup folder and schedule.' },
  { key: 'audit.view', group: 'administration', label: 'View audit log', description: 'Read the security audit trail.', sensitive: true },
  { key: 'audit.export', group: 'administration', label: 'Export audit log', description: 'Export audit entries.', sensitive: true },
  {
    key: 'printer.manage',
    group: 'administration',
    label: 'Manage printer' + ' profiles',
    description: 'Configure printers, paper sizes and templates.',
  },

  // --- Data & system -------------------------------------------------------
  {
    key: 'data.destructive',
    group: 'data',
    label: 'Reset /' + ' purge data',
    description: 'Delete all business records or reset the database.',
    sensitive: true,
  },
  {
    key: 'business.delete',
    group: 'data',
    label: 'Delete the' + ' business',
    description: 'Erase the clinic installation completely. Owner only.',
    sensitive: true,
  },
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof PERMISSION_DEFINITIONS)[number]['key'];

export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_DEFINITIONS.map((definition) => definition.key);

const PERMISSION_KEY_SET = new Set<string>(ALL_PERMISSION_KEYS);

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value);
}

export const PERMISSION_GROUPS_ORDER: readonly PermissionGroup[] = [
  'patients',
  'clinical',
  'appointments',
  'billing',
  'reports',
  'inventory',
  'accounting',
  'staff',
  'administration',
  'data',
];

/**
 * Grants are matched against a request key. The owner role is granted `*`.
 * A grant of `patient.*` also satisfies `patient.view`. Matching is exact by
 * design: `patient.view` does not imply `patient.edit`.
 */
export function permissionMatches(granted: readonly string[], required: string): boolean {
  for (const grant of granted) {
    if (grant === '*' || grant === required) return true;
    if (grant.endsWith('.*')) {
      const prefix = grant.slice(0, -1); // keep the trailing dot
      if (required.startsWith(prefix)) return true;
    }
  }
  return false;
}

export function hasAnyPermission(granted: readonly string[], required: readonly string[]): boolean {
  return required.some((key) => permissionMatches(granted, key));
}

export function missingPermissions(granted: readonly string[], required: readonly string[]): string[] {
  return required.filter((key) => !permissionMatches(granted, key));
}

/** Expand a grant list into the explicit permission set (used by the UI). */
export function expandGrants(granted: readonly string[]): PermissionKey[] {
  if (granted.includes('*')) return [...ALL_PERMISSION_KEYS];
  const expanded = new Set<string>();
  for (const grant of granted) {
    if (grant.endsWith('.*')) {
      const prefix = grant.slice(0, -1);
      for (const key of ALL_PERMISSION_KEYS) if (key.startsWith(prefix)) expanded.add(key);
    } else if (PERMISSION_KEY_SET.has(grant)) {
      expanded.add(grant);
    }
  }
  return ALL_PERMISSION_KEYS.filter((key) => expanded.has(key));
}

// ---------------------------------------------------------------------------
// System roles
// ---------------------------------------------------------------------------

export interface RolePreset {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly grants: readonly string[];
  /** Owner is protected: it always keeps full access and cannot be edited away. */
  readonly immutable?: boolean;
}

export const SYSTEM_ROLES: readonly RolePreset[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control of the clinic, including business deletion and data resets.',
    grants: ['*'],
    immutable: true,
  },
  {
    key: 'administrator',
    name: 'Administrator',
    description: 'Day-to-day management of users, settings, backups and all clinical and financial data. Cannot delete the business.',
    grants: [
      '*',
      // Owner-only authority is removed from the administrator preset.
      '!business.delete',
    ],
  },
  {
    key: 'dentist',
    name: 'Dentist',
    description: 'Clinical work: patients, visits, dental charting and prescriptions, with billing for their own treatments.',
    grants: [
      'patient.view',
      'patient.create',
      'patient.edit',
      'patient.attachment.view',
      'patient.attachment.manage',
      'patient.medical.view',
      'visit.view',
      'visit.create',
      'visit.edit',
      'chart.view',
      'chart.edit',
      'prescription.view',
      'prescription.create',
      'prescription.edit',
      'prescription.print',
      'treatment.view',
      'appointment.view',
      'appointment.create',
      'appointment.edit',
      'appointment.status',
      'queue.view',
      'queue.manage',
      'invoice.view',
      'invoice.create',
      'invoice.print',
      'payment.view',
      'payment.create',
      'inventory.view',
      'inventory.adjust',
      'report.operational.view',
      'dashboard.view',
      'dashboard.financial.view',
      'settings.view',
      'search.use',
      'dentist.view',
    ],
  },
  {
    key: 'receptionist',
    name: 'Receptionist',
    description: 'Front desk: registration, appointments, queue and payment collection without financial reports.',
    grants: [
      'patient.view',
      'patient.create',
      'patient.edit',
      'patient.attachment.view',
      'patient.attachment.manage',
      'appointment.view',
      'appointment.create',
      'appointment.edit',
      'appointment.status',
      'queue.view',
      'queue.manage',
      'invoice.view',
      'invoice.create',
      'invoice.print',
      'payment.view',
      'payment.create',
      'treatment.view',
      'dashboard.view',
      'settings.view',
      'search.use',
      'dentist.view',
    ],
  },
  {
    key: 'assistant',
    name: 'Assistant',
    description: 'Chair-side support: patient details, charting assistance and stock usage, without financial access.',
    grants: [
      'patient.view',
      'patient.create',
      'patient.edit',
      'patient.attachment.view',
      'patient.attachment.manage',
      'visit.view',
      'visit.create',
      'chart.view',
      'chart.edit',
      'prescription.view',
      'appointment.view',
      'queue.view',
      'queue.manage',
      'inventory.view',
      'inventory.adjust',
      'treatment.view',
      'dashboard.view',
      'settings.view',
      'search.use',
      'dentist.view',
    ],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Billing and accounting: invoices, payments, expenses and financial reporting. No clinical access.',
    grants: [
      'patient.view',
      'invoice.view',
      'invoice.create',
      'invoice.edit',
      'invoice.print',
      'payment.view',
      'payment.create',
      'payment.edit',
      'accounting.view',
      'accounting.manage',
      'accounting.category.manage',
      'accounting.period.manage',
      'report.financial.view',
      'report.profit.view',
      'report.export',
      'report.operational.view',
      'dashboard.view',
      'dashboard.financial.view',
      'inventory.view',
      'settings.view',
      'search.use',
    ],
  },
  {
    key: 'inventory_manager',
    name: 'Inventory manager',
    description: 'Stock control: items, suppliers, purchases, consumption and expiry monitoring.',
    grants: [
      'inventory.view',
      'inventory.manage',
      'inventory.purchase',
      'inventory.adjust',
      'accounting.view',
      'accounting.manage',
      'report.operational.view',
      'dashboard.view',
      'settings.view',
      'search.use',
    ],
  },
];

export function rolePreset(key: string): RolePreset | undefined {
  return SYSTEM_ROLES.find((preset) => preset.key === key);
}

/** Expand a preset (including its `!deny` markers) into concrete grants. */
export function resolveRoleGrants(preset: RolePreset): string[] {
  const denies = preset.grants.filter((grant) => grant.startsWith('!')).map((grant) => grant.slice(1));
  const allows = preset.grants.filter((grant) => !grant.startsWith('!'));
  const expanded = expandGrants(allows);
  return expanded.filter((key) => !denies.includes(key));
}

export const OWNER_ROLE_KEY = 'owner';
