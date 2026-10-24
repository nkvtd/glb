import type { ReportInsert } from '../schema.js';

export type SensorCommunityStationSummary = {
    locationId: number;
    latitude: number;
    longitude: number;
    pm10: number | null;
    pm25: number | null;
    temperature: number | null;
    humidity: number | null;
    pressureHpa: number | null;
};

export type SensorCommunityPayload = {
    municipalityCode: string;
    municipalityName: string;
    hourWindowUtc: string;
    activeStationCount: number;
    pmStationCount: number;
    classificationCode: string;
    averages: {
        pm10: number;
        pm25: number | null;
        temperature: number | null;
        humidity: number | null;
        pressureHpa: number | null;
    };
    stations: SensorCommunityStationSummary[];
};

export type SensorCommunityReportInsert = Omit<ReportInsert, 'rawPayload'> & {
    rawPayload: SensorCommunityPayload;
};
