export const reportCategories = [
    'power',
    'water',
    'road',
    'weather',
    'wildfire',
] as const;

export type ReportCategory = (typeof reportCategories)[number];

export const eventCategories = ['fuel_price', 'currency_exchange'] as const;

export type EventCategory = (typeof eventCategories)[number];
