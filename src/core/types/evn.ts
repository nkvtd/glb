import type { ReportInsert } from '../schema.js';

export type EvnPayload = {
    interruptionId: string;
    distributionCenterId: number;
    interruptionType: string;
    place: string;
    address: string;
    start: Date;
    end: Date;
    voltageLevel: string;
};

export type EvnReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: EvnPayload;
};
