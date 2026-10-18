import type { ReportInsert } from '../schema.js';

export type VodovodSkopjePayload = {
    interventionId: number;
    archiveNumber: string | null;
    municipality: string;
    street: string;
    streetNumber: string | null;
    locationNote: string | null;
    defectTypeId: number | null;
    defectType: string;
    interventionTypeId: number | null;
    interventionType: string | null;
    defectInfo: string | null;
    urgency: string | null;
    notifiedOutage: string | null;
    rawStatus: number;
    acceptedAt: Date;
    statusChangedAt: Date | null;
    waterShutoffAt: Date | null;
    waterRestoredAt: Date | null;
    waterShutoffType: number | null;
    hydroforPowerOutage: boolean;
    inspectionCompleted: boolean;
    coordinates: {
        lng: number;
        lat: number;
    } | null;
};

export type VodovodSkopjeReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: VodovodSkopjePayload;
};
