import type { ReportInsert } from '../schema.js';

export type VodovodPrilepSupply = {
    totalLs: number | null;
    studenchicaLs: number | null;
    wellsLs: number | null;
    springsLs: number | null;
};

export type VodovodPrilepPayload = {
    postId: number;
    date: string;
    link: string;
    title: string;
    recordType: 'supply' | 'outage' | 'notice';
    supplySummary: string | null;
    supply: VodovodPrilepSupply | null;
    street: string | null;
    streets: string[];
};

export type VodovodPrilepReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: VodovodPrilepPayload;
};
