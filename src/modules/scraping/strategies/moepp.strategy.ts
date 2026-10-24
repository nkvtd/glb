import type { MoeppReportInsert } from '../../../core/types/moepp.js';
import {
    type MoeppIndex,
    type MoeppMeasurement,
    type MoeppStation,
    moeppMeasurementsResponseSchema,
    moeppStationsResponseSchema,
} from '../../../core/validation/moepp.js';
import type { MunicipalityResolver } from '../resolver.js';
import type { ScrapingStrategy } from '../strategy.interface.js';

type MoeppRaw = {
    stations: MoeppStation[];
    measurements: MoeppMeasurement[];
};

const POOR_AIR_INDEX_CODES = new Set(['04', '05', '06']);

export class MoeppStrategy
    implements ScrapingStrategy<MoeppRaw, MoeppReportInsert>
{
    readonly source = 'moepp';
    readonly url: string;
    readonly category = 'air_quality' as const;
    readonly target = 'reports';
    readonly schedule: string;
    private readonly resolver: MunicipalityResolver;

    constructor(url: string, schedule: string, resolver: MunicipalityResolver) {
        this.url = url;
        this.schedule = schedule;
        this.resolver = resolver;
    }

    async fetch(): Promise<MoeppRaw> {
        const stationsResponse = await fetch(`${this.url}/stations`, {
            signal: AbortSignal.timeout(15_000),
        });

        if (!stationsResponse.ok) {
            const errorText = await stationsResponse.text();
            throw new Error(
                `Fetch failed with status code ${stationsResponse.status}: ${errorText}`,
            );
        }

        const stations = moeppStationsResponseSchema.parse(
            await stationsResponse.json(),
        );

        const today = new Date().toLocaleDateString('en-CA');

        const measurementsResponse = await fetch(
            `${this.url}/latest-measures-hour-stations`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    StationIds: stations.map((station) => station.id),
                    DateFrom: today,
                    DateTo: today,
                    AggregationType: 1,
                }),
                signal: AbortSignal.timeout(15_000),
            },
        );

        if (!measurementsResponse.ok) {
            const errorText = await measurementsResponse.text();
            throw new Error(
                `Fetch failed with status code ${measurementsResponse.status}: ${errorText}`,
            );
        }

        const measurements = moeppMeasurementsResponseSchema.parse(
            await measurementsResponse.json(),
        );

        return { stations, measurements };
    }

    async parse({
        stations,
        measurements,
    }: MoeppRaw): Promise<MoeppReportInsert[]> {
        const now = new Date();
        const stationsById = new Map<number, MoeppStation>(
            stations.map((station): [number, MoeppStation] => [
                station.id,
                station,
            ]),
        );
        const reports: MoeppReportInsert[] = [];

        for (const measurement of measurements) {
            const station = stationsById.get(measurement.stationID);
            if (!station) continue;

            const stationName = this.toTitleCase(station.name.trim());
            const city = this.formatCity(station.city);
            const locationLabel = this.formatLocation(stationName, city);
            const isPoor =
                measurement.aQ_Index !== null &&
                POOR_AIR_INDEX_CODES.has(measurement.aQ_Index.code);

            const municipalityCode =
                (await this.resolver
                    .resolveCoords(station.longitude, station.latitude)
                    .then((result) => result?.code ?? null)) ??
                this.resolver.resolveText(station.name) ??
                this.resolver.resolveText(station.city) ??
                this.resolver.resolveText(station.address);

            const title = `${this.formatTitlePrefix(measurement.aQ_Index)}: ${locationLabel}`;
            const description = this.formatDescription({
                stationName,
                city,
                measurement,
            });

            reports.push({
                externalId: `${station.id}-${measurement.fromTime}`,
                source: this.source,
                category: this.category,
                title,
                description,
                municipalityCode,
                locationLabel,
                geom: `SRID=4326;POINT(${station.longitude} ${station.latitude})`,
                status: isPoor ? 'ongoing' : 'omitted',
                observedAt: now,
                startsAt: new Date(measurement.toTime),
                endsAt: null,
                rawPayload: {
                    station,
                    measurement,
                },
            });
        }

        return reports;
    }

    private formatTitlePrefix(index: MoeppIndex | null): string {
        switch (index?.code) {
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
                return 'Квалитет на воздух (нема податоци)';
        }
    }

    private formatDescription(params: {
        stationName: string;
        city: string;
        measurement: MoeppMeasurement;
    }): string {
        const { stationName, city, measurement } = params;
        const aqCode = measurement.aQ_Index?.code;

        const locationPhrase =
            stationName.toLowerCase() === city.toLowerCase()
                ? `На мерната станица во ${city}`
                : `На мерната станица „${stationName}“ во ${city}`;

        const adjective = this.getClassificationAdjective(aqCode);

        if (!adjective) {
            return `${locationPhrase} моментално нема податоци за квалитетот на воздухот.`;
        }

        const aqValueSuffix =
            measurement.aQ_Value !== null
                ? ` (индекс: ${Math.round(measurement.aQ_Value)})`
                : '';

        const firstSentence = `${locationPhrase} е измерен ${adjective} квалитет на воздухот${aqValueSuffix}.`;
        const pollutantsSentence = this.formatPollutantsSentence(measurement);

        return pollutantsSentence
            ? `${firstSentence} ${pollutantsSentence}`
            : firstSentence;
    }

    private formatPollutantsSentence(
        measurement: MoeppMeasurement,
    ): string | null {
        const entries: Array<{
            label: string;
            value: number | null;
            unit: string;
            index: MoeppIndex | null;
        }> = [
            {
                label: 'PM10',
                value: measurement.pM10_Value,
                unit: 'µg/m³',
                index: measurement.pM10_Index,
            },
            {
                label: 'PM2.5',
                value: measurement.pM25_Value,
                unit: 'µg/m³',
                index: measurement.pM25_Index,
            },
            {
                label: 'NO₂',
                value: measurement.nO2_Value,
                unit: 'µg/m³',
                index: measurement.nO2_Index,
            },
            {
                label: 'O₃',
                value: measurement.o3_Value,
                unit: 'µg/m³',
                index: measurement.o3_Index,
            },
            {
                label: 'SO₂',
                value: measurement.sO2_Value,
                unit: 'µg/m³',
                index: measurement.sO2_Index,
            },
            {
                label: 'CO',
                value: measurement.cO_Value,
                unit: 'mg/m³',
                index: measurement.cO_Index,
            },
        ];

        const active: string[] = [];

        for (const e of entries) {
            if (e.value !== null && e.index && e.index.code !== '08') {
                const formattedVal = Number(e.value.toFixed(1));
                const level = e.index.name.trim().toLowerCase();
                active.push(
                    `${e.label} од ${formattedVal} ${e.unit} (${level})`,
                );
            }
        }

        if (active.length === 0) return null;

        if (active.length === 1) {
            return `Измерена е концентрација на ${active[0]}.`;
        }

        const last = active[active.length - 1];
        const rest = active.slice(0, -1);

        return `Измерени концентрации: ${rest.join(', ')} и ${last}.`;
    }

    private getClassificationAdjective(code?: string): string | null {
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
                return null;
        }
    }

    private formatCity(rawCity: string): string {
        const cleaned = rawCity
            .replace(/^Скопје\s*-\s*/i, '')
            .replace(/^с\.\s*/i, '')
            .trim();

        return this.toTitleCase(cleaned);
    }

    private formatLocation(stationName: string, city: string): string {
        if (!city || stationName.toLowerCase() === city.toLowerCase()) {
            return stationName;
        }

        return `${stationName}, ${city}`;
    }

    private toTitleCase(text: string): string {
        return text
            .toLowerCase()
            .replace(/\p{L}+/gu, (word) =>
                word.length <= 2
                    ? word.toUpperCase()
                    : word.charAt(0).toUpperCase() + word.slice(1),
            );
    }
}
