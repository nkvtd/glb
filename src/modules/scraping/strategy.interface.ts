import type { EventCategory, ReportCategory } from '../../core/enums.js';
import type { EventInsert, ReportInsert } from '../../core/schema.js';

export interface ScrapingStrategy<
    TRaw = unknown,
    TInsert extends ReportInsert | EventInsert = ReportInsert | EventInsert,
> {
    readonly source: string;
    readonly url: string;
    readonly category: ReportCategory | EventCategory;
    readonly target: 'reports' | 'events';
    readonly schedule: string;

    fetch(): Promise<TRaw>;
    parse(raw: TRaw): Promise<TInsert[]>;
}
