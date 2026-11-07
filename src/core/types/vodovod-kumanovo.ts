import type { ReportInsert } from '../schema.js';

export type VodovodKumanovoPayload = {
    postId: number;
    date: string;
    link: string;
    title: string;
    item: string;
    items: string[];
};

export type VodovodKumanovoReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: VodovodKumanovoPayload;
};
