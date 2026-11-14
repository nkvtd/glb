export const reportCategories = [
    'power',
    'water',
    'road',
    'weather',
    'wildfire',
    'air_quality',
    'earthquake',
    'internet',
] as const;

export type ReportCategory = (typeof reportCategories)[number];

export const eventCategories = [
    'fuel_price',
    'currency_exchange',
    'internet',
] as const;

export type EventCategory = (typeof eventCategories)[number];
