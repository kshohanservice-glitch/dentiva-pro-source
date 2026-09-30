/**
 * Category naming used by the automatic postings so the ledger stays readable
 * and stable across releases.
 */
export const INCOME_CATEGORY_PAYMENT = 'Treatment revenue';
export const INCOME_CATEGORY_PRODUCT = 'Product sales';
export const EXPENSE_CATEGORY_SUPPLIES = 'Dental supplies';
export const EXPENSE_CATEGORY_SALARY = 'Staff salary';
export const EXPENSE_CATEGORY_RENT = 'Clinic rent';

export function deriveIncomeCategoryName(source: 'payment' | 'product' | 'other'): string {
  switch (source) {
    case 'product':
      return INCOME_CATEGORY_PRODUCT;
    case 'payment':
    default:
      return INCOME_CATEGORY_PAYMENT;
  }
}

export function deriveExpenseCategoryName(source: 'purchase' | 'salary' | 'rent' | 'other'): string {
  switch (source) {
    case 'salary':
      return EXPENSE_CATEGORY_SALARY;
    case 'rent':
      return EXPENSE_CATEGORY_RENT;
    case 'purchase':
    default:
      return EXPENSE_CATEGORY_SUPPLIES;
  }
}
