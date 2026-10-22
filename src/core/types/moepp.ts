import type { ReportInsert } from '../schema.js';
import type { MoeppMeasurement, MoeppStation } from '../validation/moepp.js';

export type MoeppPayload = {
    station: MoeppStation;
    measurement: MoeppMeasurement;
};

export type MoeppReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: MoeppPayload;
};
