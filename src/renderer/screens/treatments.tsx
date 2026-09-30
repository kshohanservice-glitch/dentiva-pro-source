/**
 * Clinical catalogues: treatments, medications, clinical option lists and
 * referral doctors. These are the lists that make day-to-day entry fast.
 */
import { useState } from 'react';
import { MEDICATION_FORMS, REFERRAL_SPECIALTIES } from '@shared/constants';
import { fmtMoney, num, text } from '@renderer/lib/format';
import { Badge, Stat, Tabs } from '@renderer/components/ui';
import { ResourceManager } from '@renderer/components/resource-manager';
import { useApi } from '@renderer/state/store';

const TABS = [
  { key: 'treatments', label: 'Treatment catalogue' },
  { key: 'medications', label: 'Medicines' },
  { key: 'clinical-options', label: 'Clinical options' },
  { key: 'referral-doctors', label: 'Referral doctors' },
];

export function TreatmentsScreen(): JSX.Element {
  const [tab, setTab] = useState('treatments');
  const statistics = useApi('reports.catalogue', undefined);

  return (
    <div className="page">
      <header className="page__header">
        <div>
          <h1 className="page__heading">Treatments &amp; clinical lists</h1>
          <p className="page__description">Prices entered here appear on invoices; medicines and clinical options speed up prescribing.</p>
        </div>
      </header>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'treatments' ? (
        <>
          <div className="stat-grid">
            <Stat label="Report catalogue" value={String(statistics.data?.length ?? 0)} hint="Ready-made reports in Reports" />
          </div>
          <ResourceManager
            resource="treatments"
            title="Treatment catalogue"
            description="Codes are printed on invoices; keep them short and stable."
            emptyText="No treatments yet — add the procedures your clinic performs."
            columns={[
              { key: 'code', label: 'Code', render: (row) => <span className="mono small">{text(row['code'])}</span> },
              { key: 'name', label: 'Treatment' },
              { key: 'category', label: 'Category' },
              { key: 'pricePaisa', label: 'Price', align: 'right', render: (row) => fmtMoney(Number(row['pricePaisa'] ?? 0)) },
              { key: 'durationMinutes', label: 'Minutes', align: 'right' },
              { key: 'usageCount', label: 'Used', align: 'right', render: (row) => String(num(row['usageCount'])) },
              {
                key: 'isActive',
                label: 'State',
                render: (row) => (row['isActive'] === false ? <Badge>Inactive</Badge> : <Badge tone="success">Active</Badge>),
              },
            ]}
            fields={[
              { key: 'code', label: 'Code', type: 'text', required: true, hint: 'For example SCA, RCT, EXT' },
              { key: 'name', label: 'Name', type: 'text', required: true },
              { key: 'category', label: 'Category', type: 'text', hint: 'Preventive, Restorative, Surgery…' },
              { key: 'description', label: 'Description', type: 'textarea' },
              { key: 'pricePaisa', label: 'Price', type: 'money', required: true, defaultValue: 0 },
              { key: 'durationMinutes', label: 'Duration (minutes)', type: 'number', defaultValue: 30 },
              { key: 'isActive', label: 'Active', type: 'switch', defaultValue: true },
            ]}
          />
        </>
      ) : null}

      {tab === 'medications' ? (
        <ResourceManager
          resource="medications"
          title="Medicines"
          description="Defaults pre-fill the prescription editor; the dose pattern is morning / noon / night."
          emptyText="No medicines yet — add the ones you prescribe most."
          columns={[
            { key: 'name', label: 'Medicine' },
            { key: 'form', label: 'Form' },
            { key: 'strength', label: 'Strength' },
            {
              key: 'defaultDoseMorning',
              label: 'Default dose (M-N-N)',
              render: (row) => `${num(row['defaultDoseMorning'])} - ${num(row['defaultDoseNoon'])} - ${num(row['defaultDoseNight'])}`,
            },
            { key: 'defaultFoodTiming', label: 'Food', render: (row) => text(row['defaultFoodTiming']).replace(/_/g, ' ') },
            { key: 'usageCount', label: 'Used', align: 'right', render: (row) => String(num(row['usageCount'])) },
            {
              key: 'isActive',
              label: 'State',
              render: (row) => (row['isActive'] === false ? <Badge>Inactive</Badge> : <Badge tone="success">Active</Badge>),
            },
          ]}
          fields={[
            { key: 'name', label: 'Name', type: 'text', required: true },
            {
              key: 'form',
              label: 'Form',
              type: 'select',
              required: true,
              defaultValue: 'tablet',
              options: MEDICATION_FORMS.map((option) => ({ value: option.value, label: option.label })),
            },
            { key: 'strength', label: 'Strength', type: 'text', hint: '500 mg, 250 mg/5 ml…' },
            { key: 'defaultDoseMorning', label: 'Morning dose', type: 'number', defaultValue: 1 },
            { key: 'defaultDoseNoon', label: 'Noon dose', type: 'number', defaultValue: 1 },
            { key: 'defaultDoseNight', label: 'Night dose', type: 'number', defaultValue: 1 },
            {
              key: 'defaultFoodTiming',
              label: 'Food timing',
              type: 'select',
              defaultValue: 'after_food',
              options: [
                { value: 'after_food', label: 'After food' },
                { value: 'before_food', label: 'Before food' },
                { value: 'with_food', label: 'With food' },
                { value: 'empty_stomach', label: 'Empty stomach' },
                { value: 'any_time', label: 'Any time' },
              ],
            },
            { key: 'defaultDurationDays', label: 'Default days', type: 'number', defaultValue: 5 },
            { key: 'isActive', label: 'Active', type: 'switch', defaultValue: true },
          ]}
        />
      ) : null}

      {tab === 'clinical-options' ? (
        <ResourceManager
          resource="clinical-options"
          title="Clinical options"
          description="The chips offered for C/C, O/E, R/E and advice on visits and prescriptions."
          includeInactive
          emptyText="No clinical options yet."
          columns={[
            { key: 'category', label: 'Section', render: (row) => text(row['category']).toUpperCase() },
            { key: 'label', label: 'Text' },
            { key: 'sortOrder', label: 'Order', align: 'right' },
            { key: 'usageCount', label: 'Used', align: 'right', render: (row) => String(num(row['usageCount'])) },
            {
              key: 'isActive',
              label: 'State',
              render: (row) => (row['isActive'] === false ? <Badge>Inactive</Badge> : <Badge tone="success">Active</Badge>),
            },
          ]}
          fields={[
            {
              key: 'category',
              label: 'Section',
              type: 'select',
              required: true,
              defaultValue: 'cc',
              options: [
                { value: 'cc', label: 'C/C — Chief complaint' },
                { value: 'oe', label: 'O/E — On examination' },
                { value: 're', label: 'R/E — Diagnosis' },
                { value: 'advice', label: 'Advice' },
              ],
            },
            { key: 'label', label: 'Text', type: 'text', required: true },
            { key: 'sortOrder', label: 'Sort order', type: 'number', defaultValue: 10 },
            { key: 'isActive', label: 'Active', type: 'switch', defaultValue: true },
          ]}
        />
      ) : null}

      {tab === 'referral-doctors' ? (
        <ResourceManager
          resource="referral-doctors"
          title="Referral doctors"
          description="Specialists this clinic refers patients to."
          emptyText="No referral doctors yet."
          columns={[
            { key: 'name', label: 'Doctor' },
            { key: 'specialty', label: 'Specialty' },
            { key: 'organisation', label: 'Organisation' },
            { key: 'phone', label: 'Phone' },
          ]}
          fields={[
            { key: 'name', label: 'Doctor name', type: 'text', required: true },
            {
              key: 'specialty',
              label: 'Specialty',
              type: 'select',
              options: REFERRAL_SPECIALTIES.map((specialty) => ({ value: specialty, label: specialty })),
            },
            { key: 'organisation', label: 'Hospital / chamber', type: 'text' },
            { key: 'phone', label: 'Phone', type: 'text' },
            { key: 'email', label: 'Email', type: 'text' },
            { key: 'address', label: 'Address', type: 'textarea' },
            { key: 'notes', label: 'Notes', type: 'textarea' },
            { key: 'isActive', label: 'Active', type: 'switch', defaultValue: true },
          ]}
        />
      ) : null}
    </div>
  );
}
