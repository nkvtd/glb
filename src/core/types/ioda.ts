import type { EventInsert, ReportInsert } from '../schema.js';

export type IodaSignalMetric = {
    current: number;
    baseline: number;
    ratio: number;
};

export type IodaOperatorSummary = {
    name: string;
    asns: string[];
    status: 'normal' | 'degraded' | 'outage';
    availabilityPct: number;
    bgp: IodaSignalMetric | null;
    ping: IodaSignalMetric | null;
};

export type IodaEventPayload = {
    countryCode: 'MK';
    status: 'normal' | 'degraded' | 'outage';
    availabilityPct: number;
    bgp: IodaSignalMetric | null;
    ping: IodaSignalMetric | null;
    affectedOperators: string[];
    operators: IodaOperatorSummary[];
};

export type IodaReportPayload = {
    municipalityCode: string;
    municipalityName: string;
    regionCodes: string[];
    status: 'normal' | 'degraded' | 'outage';
    availabilityPct: number;
    bgp: IodaSignalMetric | null;
    ping: IodaSignalMetric | null;
};

export type IodaEventInsert = Omit<EventInsert, 'rawPayload'> & {
    rawPayload: IodaEventPayload;
};

export type IodaReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: IodaReportPayload;
};
