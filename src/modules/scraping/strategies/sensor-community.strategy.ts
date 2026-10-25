import type {
    SensorCommunityReportInsert,
    SensorCommunityStationSummary,
} from '../../../core/types/sensor-community.js';
import {
    type SensorCommunityItem,
    sensorCommunityResponseSchema,
} from '../../../core/validation/sensor-community.js';
import type { MunicipalityResolver } from '../resolver.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

type StationAccumulator = {
    locationId: number;
    latitude: number;
    longitude: number;
    latestTimestampMs: number;
    pm10Values: number[];
    pm25Values: number[];
    tempValues: number[];
    humidityValues: number[];
    pressureHpaValues: number[];
};

const POOR_AIR_CODES = new Set(['04', '05', '06']);

export class SensorCommunityStrategy
    implements
        ScrapingStrategy<SensorCommunityItem[], SensorCommunityReportInsert>
{
    readonly source = 'sensor-community';
    readonly url: string;
    readonly category = 'air_quality' as const;
    readonly target = 'reports';
    readonly schedule: string;
    readonly stateFeed = true;
    private readonly resolver: MunicipalityResolver;

    constructor(url: string, schedule: string, resolver: MunicipalityResolver) {
        this.url = url;
        this.schedule = schedule;
        this.resolver = resolver;
    }

    async fetch(): Promise<SensorCommunityItem[]> {
        const response = await fetch(this.url, {
            signal: AbortSignal.timeout(20_000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
                `Fetch failed with status code ${response.status}: ${errorText}`,
            );
        }

        const data = await response.json();

        return sensorCommunityResponseSchema.parse(data);
    }

    async parse(
        items: SensorCommunityItem[],
    ): Promise<SensorCommunityReportInsert[]> {
        const now = new Date();
        const stationsById = new Map<number, StationAccumulator>();

        for (const item of items) {
            const { location, sensordatavalues } = item;

            if (
                location.indoor !== 0 ||
                location.country.toUpperCase() !== 'MK' ||
                !Number.isFinite(location.latitude) ||
                !Number.isFinite(location.longitude)
            ) {
                continue;
            }

            const parsedTime = Date.parse(
                `${item.timestamp.trim().replace(' ', 'T')}Z`,
            );
            const timestampMs = Number.isNaN(parsedTime)
                ? now.getTime()
                : parsedTime;

            let station = stationsById.get(location.id);
            if (!station) {
                station = {
                    locationId: location.id,
                    latitude: location.latitude,
                    longitude: location.longitude,
                    latestTimestampMs: timestampMs,
                    pm10Values: [],
                    pm25Values: [],
                    tempValues: [],
                    humidityValues: [],
                    pressureHpaValues: [],
                };
                stationsById.set(location.id, station);
            } else if (timestampMs > station.latestTimestampMs) {
                station.latestTimestampMs = timestampMs;
            }

            let rawP1: number | null = null;
            let rawP2: number | null = null;

            for (const v of sensordatavalues) {
                if (!Number.isFinite(v.value)) continue;

                switch (v.value_type) {
                    case 'P1':
                        rawP1 = v.value;
                        break;
                    case 'P2':
                        rawP2 = v.value;
                        break;
                    case 'temperature':
                        if (v.value >= -35 && v.value <= 50) {
                            station.tempValues.push(v.value);
                        }
                        break;
                    case 'humidity':
                        if (v.value > 5 && v.value < 99) {
                            station.humidityValues.push(v.value);
                        }
                        break;
                    case 'pressure_at_sealevel':
                    case 'pressure': {
                        const hpa = v.value > 2000 ? v.value / 100 : v.value;
                        if (hpa >= 850 && hpa <= 1100) {
                            station.pressureHpaValues.push(hpa);
                        }
                        break;
                    }
                }
            }

            const isValidP1 = rawP1 !== null && rawP1 > 0.5 && rawP1 < 1000;
            const isValidP2 = rawP2 !== null && rawP2 > 0.5 && rawP2 < 500;
            const isRatioSane =
                !isValidP1 ||
                !isValidP2 ||
                (rawP2 as number) <= (rawP1 as number) * 1.05;

            if (isRatioSane) {
                if (isValidP1 && rawP1 !== null) {
                    station.pm10Values.push(rawP1);
                }
                if (isValidP2 && rawP2 !== null) {
                    station.pm25Values.push(rawP2);
                }
            }
        }

        const byMunicipality = new Map<
            string,
            {
                municipalityName: string;
                latestTimestampMs: number;
                stations: SensorCommunityStationSummary[];
            }
        >();

        for (const acc of stationsById.values()) {
            const humidityMean = this.mean(acc.humidityValues);

            const pm10 =
                humidityMean !== null && humidityMean >= 90
                    ? null
                    : this.mean(acc.pm10Values);
            const pm25 =
                humidityMean !== null && humidityMean >= 90
                    ? null
                    : this.mean(acc.pm25Values);

            if (pm10 === null && pm25 === null) continue;

            const municipalityData = await this.resolver.resolveCoords(
                acc.longitude,
                acc.latitude,
            );

            const municipalityCode = municipalityData?.code ?? null;

            if (!municipalityCode) continue;

            const municipalityName = municipalityData?.name ?? null;
            if (!municipalityName) continue;

            const summary: SensorCommunityStationSummary = {
                locationId: acc.locationId,
                latitude: acc.latitude,
                longitude: acc.longitude,
                pm10: pm10 !== null ? Number(pm10.toFixed(1)) : null,
                pm25: pm25 !== null ? Number(pm25.toFixed(1)) : null,
                temperature:
                    acc.tempValues.length > 0
                        ? Number(
                              (this.mean(acc.tempValues) as number).toFixed(1),
                          )
                        : null,
                humidity:
                    humidityMean !== null
                        ? Number(humidityMean.toFixed(1))
                        : null,
                pressureHpa:
                    acc.pressureHpaValues.length > 0
                        ? Number(
                              (
                                  this.mean(acc.pressureHpaValues) as number
                              ).toFixed(1),
                          )
                        : null,
            };

            const group = byMunicipality.get(municipalityCode) ?? {
                municipalityName,
                latestTimestampMs: acc.latestTimestampMs,
                stations: [],
            };

            if (acc.latestTimestampMs > group.latestTimestampMs) {
                group.latestTimestampMs = acc.latestTimestampMs;
            }
            group.stations.push(summary);
            byMunicipality.set(municipalityCode, group);
        }

        const reports: SensorCommunityReportInsert[] = [];

        for (const [municipalityCode, group] of byMunicipality.entries()) {
            const pm10List = group.stations
                .map((s) => s.pm10)
                .filter((v): v is number => v !== null);
            if (pm10List.length === 0) continue;

            const pm25List = group.stations
                .map((s) => s.pm25)
                .filter((v): v is number => v !== null);
            const tempList = group.stations
                .map((s) => s.temperature)
                .filter((v): v is number => v !== null);
            const humidityList = group.stations
                .map((s) => s.humidity)
                .filter((v): v is number => v !== null);
            const pressureList = group.stations
                .map((s) => s.pressureHpa)
                .filter((v): v is number => v !== null);

            const avgPm10 = Number(
                (this.trimmedMean(pm10List) as number).toFixed(1),
            );
            const avgPm25 =
                pm25List.length > 0
                    ? Number((this.trimmedMean(pm25List) as number).toFixed(1))
                    : null;
            const avgTemp =
                tempList.length > 0
                    ? Number((this.trimmedMean(tempList) as number).toFixed(1))
                    : null;
            const avgHumidity =
                humidityList.length > 0
                    ? Number(
                          (this.trimmedMean(humidityList) as number).toFixed(1),
                      )
                    : null;
            const avgPressure =
                pressureList.length > 0
                    ? Number(
                          (this.trimmedMean(pressureList) as number).toFixed(1),
                      )
                    : null;

            const centroidLng = Number(
                (
                    this.mean(group.stations.map((s) => s.longitude)) as number
                ).toFixed(6),
            );
            const centroidLat = Number(
                (
                    this.mean(group.stations.map((s) => s.latitude)) as number
                ).toFixed(6),
            );

            const classificationCode = this.classifyAirQuality(
                avgPm10,
                avgPm25,
            );
            const isPoor = POOR_AIR_CODES.has(classificationCode);

            const startsAt = new Date(group.latestTimestampMs);
            const hourWindowUtc = `${startsAt.toISOString().slice(0, 13)}:00:00Z`;

            const locationLabel = group.municipalityName;
            const title = `${this.formatTitlePrefix(classificationCode)}: ${locationLabel}`;
            const description = this.formatDescription({
                municipalityName: locationLabel,
                stationCount: group.stations.length,
                classificationCode,
                pm10: avgPm10,
                pm25: avgPm25,
                temperature: avgTemp,
                humidity: avgHumidity,
            });

            reports.push({
                externalId: `${municipalityCode}-${hourWindowUtc}`,
                source: this.source,
                category: this.category,
                title,
                description,
                municipalityCode,
                locationLabel,
                geom: `SRID=4326;POINT(${centroidLng} ${centroidLat})`,
                status: isPoor ? 'ongoing' : 'omitted',
                observedAt: now,
                startsAt,
                endsAt: null,
                rawPayload: {
                    municipalityCode,
                    municipalityName: locationLabel,
                    hourWindowUtc,
                    activeStationCount: group.stations.length,
                    pmStationCount: pm10List.length,
                    classificationCode,
                    averages: {
                        pm10: avgPm10,
                        pm25: avgPm25,
                        temperature: avgTemp,
                        humidity: avgHumidity,
                        pressureHpa: avgPressure,
                    },
                    stations: group.stations,
                },
            });
        }

        return reports;
    }

    private mean(values: number[]): number | null {
        if (values.length === 0) return null;
        let sum = 0;
        for (const v of values) {
            sum += v;
        }
        return sum / values.length;
    }

    private trimmedMean(values: number[]): number | null {
        if (values.length === 0) return null;
        if (values.length < 4) return this.mean(values);

        const sorted = [...values].sort((a, b) => a - b);
        const trimCount = Math.max(1, Math.floor(sorted.length * 0.2));
        const sliced = sorted.slice(trimCount, sorted.length - trimCount);

        return this.mean(sliced);
    }

    private classifyAirQuality(pm10: number, pm25: number | null): string {
        const pm10Band = this.classifyPm10(pm10);
        const pm25Band = pm25 !== null ? this.classifyPm25(pm25) : 1;
        const worst = Math.max(pm10Band, pm25Band);

        return `0${worst}`;
    }

    private classifyPm10(pm10: number): number {
        if (pm10 <= 20) return 1;
        if (pm10 <= 40) return 2;
        if (pm10 <= 50) return 3;
        if (pm10 <= 100) return 4;
        if (pm10 <= 150) return 5;
        return 6;
    }

    private classifyPm25(pm25: number): number {
        if (pm25 <= 10) return 1;
        if (pm25 <= 20) return 2;
        if (pm25 <= 25) return 3;
        if (pm25 <= 50) return 4;
        if (pm25 <= 75) return 5;
        return 6;
    }

    private formatTitlePrefix(code: string): string {
        switch (code) {
            case '01':
                return 'Добар квалитет на воздух';
            case '02':
                return 'Прифатлив квалитет на воздух';
            case '03':
                return 'Умерен квалитет на воздух';
            case '04':
                return 'Лош квалитет на воздух';
            case '05':
                return 'Многу лош квалитет на воздух';
            case '06':
                return 'Екстремно лош квалитет на воздух';
            default:
                return 'Квалитет на воздух';
        }
    }

    private getClassificationAdjective(code: string): string {
        switch (code) {
            case '01':
                return 'добар';
            case '02':
                return 'прифатлив';
            case '03':
                return 'умерен';
            case '04':
                return 'лош';
            case '05':
                return 'многу лош';
            case '06':
                return 'екстремно лош';
            default:
                return 'просечен';
        }
    }

    private formatDescription(params: {
        municipalityName: string;
        stationCount: number;
        classificationCode: string;
        pm10: number;
        pm25: number | null;
        temperature: number | null;
        humidity: number | null;
    }): string {
        const adjective = this.getClassificationAdjective(
            params.classificationCode,
        );

        const firstSentence = `Според приватните мерни станици во ${params.municipalityName} (${params.stationCount === 1 ? '1 активна мерна станица' : `${params.stationCount} активни мерни станици`}) е измерен ${adjective} квалитет на воздухот.`;

        const pm10Level = this.getClassificationAdjective(
            `0${this.classifyPm10(params.pm10)}`,
        );
        const pollutants = [`PM10 од ${params.pm10} µg/m³ (${pm10Level})`];

        if (params.pm25 !== null) {
            const pm25Level = this.getClassificationAdjective(
                `0${this.classifyPm25(params.pm25)}`,
            );
            pollutants.push(`PM2.5 од ${params.pm25} µg/m³ (${pm25Level})`);
        }

        const pollutantsSentence =
            pollutants.length === 1
                ? `Просечна концентрација: ${pollutants[0]}.`
                : `Просечни концентрации: ${pollutants.join(' и ')}.`;

        const weatherParts: string[] = [];
        if (params.temperature !== null) {
            weatherParts.push(`температура од ${params.temperature} °C`);
        }
        if (params.humidity !== null) {
            weatherParts.push(
                `релативна влажност од ${Math.round(params.humidity)}%`,
            );
        }

        if (weatherParts.length === 0) {
            return `${firstSentence} ${pollutantsSentence}`;
        }

        return `${firstSentence} ${pollutantsSentence} Измерена е ${weatherParts.join(' и ')}.`;
    }
}
