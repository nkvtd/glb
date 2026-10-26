import type { ReportInsert } from '../schema.js';

export type EmscPayload = {
    unid: string;
    sourceId: string;
    sourceCatalog: string;
    authority: string;
    eventType: string | null;
    magnitude: number;
    magnitudeType: string;
    depthKm: number;
    flynnRegion: string;
    occurredAt: Date;
    lastUpdatedAt: Date;
    coordinates: {
        lng: number;
        lat: number;
    };
};

export type EmscReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: EmscPayload;
};
