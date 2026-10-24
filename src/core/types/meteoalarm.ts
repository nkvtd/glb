import type { ReportInsert } from '../schema.js';

export type MeteoalarmPayload = {
    uuid: string;
    identifier: string;
    sender: string;
    sentAt: Date;
    status: string;
    msgType: string;
    event: string;
    severity: string | null;
    urgency: string | null;
    certainty: string | null;
    awarenessLevel: {
        code: number;
        color: string;
        label: string;
    } | null;
    awarenessType: {
        code: number;
        label: string;
    } | null;
    regionCode: string | null;
    areaDesc: string;
    headline: string | null;
    description: string | null;
    web: string | null;
};

export type MeteoalarmReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: MeteoalarmPayload;
};
