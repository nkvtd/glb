import type { EventInsert, ReportInsert } from '../../core/schema.js';

export interface ScrapingStrategy<
    TRaw = unknown,
    TInsert extends ReportInsert | EventInsert = ReportInsert | EventInsert,
> {
    readonly source: string;
    readonly url: string;
    readonly target: 'reports' | 'events';
    readonly schedule: string;
    readonly stateFeed?: boolean;

    fetch(): Promise<TRaw>;
    parse(raw: TRaw): Promise<TInsert[]>;
}
