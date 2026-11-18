import type { ReportInsert } from '../schema.js';

export type OpstinaVelesPayload = {
    postId: number;
    date: string;
    dateGmt: string;
    link: string;
    title: string;
};

export type OpstinaVelesReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: OpstinaVelesPayload;
};
