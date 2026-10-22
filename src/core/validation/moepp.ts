import { z } from 'zod';

export const moeppIndexSchema = z.object({
    code: z.string(),
    color: z.string(),
    name: z.string(),
    nameEN: z.string(),
});

export const moeppStationSchema = z.object({
    id: z.number(),
    code: z.string(),
    name: z.string(),
    longitude: z.number(),
    latitude: z.number(),
    isActive: z.boolean(),
    created: z.string(),
    regionID: z.number(),
    city: z.string(),
    typeOfStation: z.string(),
    areaType: z.string(),
    address: z.string(),
    altituda: z.number(),
    pollutants: z.string(),
    cityEN: z.string(),
    addressEN: z.string(),
    areaTypeEN: z.string(),
    typeOfStationEN: z.string(),
    nameEN: z.string(),
});

export const moeppMeasurementSchema = z.object({
    stationID: z.number(),
    stationName: z.string(),
    stationNameEN: z.string(),
    fromTime: z.string(),
    toTime: z.string(),
    aQ_Value: z.number().nullable(),
    aQ_Index: moeppIndexSchema.nullable(),
    cO_Value: z.number().nullable(),
    cO_Index: moeppIndexSchema.nullable(),
    nO2_Value: z.number().nullable(),
    nO2_Index: moeppIndexSchema.nullable(),
    o3_Value: z.number().nullable(),
    o3_Index: moeppIndexSchema.nullable(),
    pM25_Value: z.number().nullable(),
    pM25_Index: moeppIndexSchema.nullable(),
    pM10_Value: z.number().nullable(),
    pM10_Index: moeppIndexSchema.nullable(),
    sO2_Value: z.number().nullable(),
    sO2_Index: moeppIndexSchema.nullable(),
});

export const moeppStationsResponseSchema = z.array(moeppStationSchema);

export const moeppMeasurementsResponseSchema = z.array(moeppMeasurementSchema);

export type MoeppIndex = z.infer<typeof moeppIndexSchema>;
export type MoeppStation = z.infer<typeof moeppStationSchema>;
export type MoeppMeasurement = z.infer<typeof moeppMeasurementSchema>;
