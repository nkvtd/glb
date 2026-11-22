import type { ReportInsert } from '../schema.js';

export type OpstinaOhridPayload = {
    postId: number;
    date: string;
    dateGmt: string;
    link: string;
    title: string;
};

export type OpstinaOhridReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: OpstinaOhridPayload;
};
