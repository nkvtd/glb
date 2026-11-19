import type { ReportInsert } from '../schema.js';

export type OpstinaDebrcaPayload = {
    postId: number;
    date: string;
    dateGmt: string;
    link: string;
    title: string;
};

export type OpstinaDebrcaReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: OpstinaDebrcaPayload;
};
