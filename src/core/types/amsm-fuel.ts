import type { EventInsert } from '../schema.js';

export type AmsmFuelPayload = {
    postId: number;
    slug: string;
    country: string;
    currency: string;
    pricesMkd: {
        eurosuper95: number;
        eurosuper98: number;
        eurodiesel: number;
    };
    pricesEur: {
        eurosuper95: number;
        eurosuper98: number;
        eurodiesel: number;
    };
    lastUpdated: string;
    modifiedAt: string;
};

export type AmsmFuelEventInsert = Omit<EventInsert, 'rawPayload'> & {
    rawPayload: AmsmFuelPayload;
};
