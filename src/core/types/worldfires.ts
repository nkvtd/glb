import type { ReportInsert } from '../schema.js';

export type WorldFiresHotspotSummary = {
    lat: number;
    lng: number;
    frpMw: number;
};

export type WorldFiresPayload = {
    detectedAt: Date;
    frpMw: number;
    hotspotCount: number;
    satellite: string;
    sensor: string;
    coordinates: {
        lng: number;
        lat: number;
    };
    hotspots: WorldFiresHotspotSummary[];
};

export type WorldFiresReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: WorldFiresPayload;
};
