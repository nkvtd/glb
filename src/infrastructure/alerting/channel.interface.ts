import type { EventItem, ReportItem } from '../../core/schema.js';

export type AlertItem = ReportItem | EventItem;

export interface AlertChannel {
    readonly name: string;
    send(items: AlertItem[]): Promise<void>;
}
