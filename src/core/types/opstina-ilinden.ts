import type { ReportInsert } from '../schema.js';

export type OpstinaIlindenPayload = {
    postId: number;
    date: string;
    dateGmt: string;
    link: string;
    title: string;
};

export type OpstinaIlindenReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: OpstinaIlindenPayload;
};
