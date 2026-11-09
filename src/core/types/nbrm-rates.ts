import type { EventInsert } from '../schema.js';

export type NbrmRateEntry = {
    oznaka: string;
    valuta: string;
    nazivMak: string;
    nomin: number;
    sreden: number;
};

export type NbrmRatesPayload = {
    rBr: number;
    datum_f: string;
    dates: string[];
    rates: NbrmRateEntry[];
};

export type NbrmRatesEventInsert = Omit<EventInsert, 'rawPayload'> & {
    rawPayload: NbrmRatesPayload;
};
