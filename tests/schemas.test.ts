import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { amsmFuelResponseSchema } from '../src/core/validation/amsm-fuel.js';
import { emscResponseSchema } from '../src/core/validation/emsc.js';
import { evnResponseSchema } from '../src/core/validation/evn.js';
import { iodaSignalsResponseSchema } from '../src/core/validation/ioda.js';
import { meteoalarmResponseSchema } from '../src/core/validation/meteoalarm.js';
import {
    moeppMeasurementsResponseSchema,
    moeppStationsResponseSchema,
} from '../src/core/validation/moepp.js';
import { nbrmRatesResponseSchema } from '../src/core/validation/nbrm-rates.js';
import { opstinaDebrcaResponseSchema } from '../src/core/validation/opstina-debrca.js';
import { opstinaIlindenResponseSchema } from '../src/core/validation/opstina-ilinden.js';
import { opstinaVelesResponseSchema } from '../src/core/validation/opstina-veles.js';
import { sensorCommunityResponseSchema } from '../src/core/validation/sensor-community.js';
import { vodovodKumanovoResponseSchema } from '../src/core/validation/vodovod-kumanovo.js';
import { vodovodPrilepResponseSchema } from '../src/core/validation/vodovod-prilep.js';
import { vodovodSkopjeResponseSchema } from '../src/core/validation/vodovod-skopje.js';
import { worldFiresHotspotsResponseSchema } from '../src/core/validation/worldfires.js';
import { at, present } from './util/assertions.js';
import {
    alert,
    debrcaPost,
    emscFeature,
    fuel,
    ilindenPost,
    iodaSeries,
    kumanovoPost,
    measurement,
    nbrmRate,
    prilepPost,
    sensor,
    station,
    velesPost,
    worldFiresHotspot,
} from './util/fixtures.js';

describe('evnResponseSchema', () => {
    const evnItem = {
        prekinID: '1',
        kecId: 1,
        tipPrekin: 'Test',
        nasMesto: 'A',
        adresa: 'B',
        pocetok: '2026-10-25T00:00:00Z',
        kraj: '2026-10-25T01:00:00Z',
        napNivo: 'НН',
    };

    it('parses wire items and coerces outage timestamps to Dates', () => {
        const evn = evnResponseSchema.parse([evnItem]);
        assert.ok(at(evn, 0).pocetok instanceof Date);
        assert.equal(
            at(evn, 0).pocetok.toISOString(),
            '2026-10-25T00:00:00.000Z',
        );
        assert.ok(at(evn, 0).kraj instanceof Date);
    });

    it('rejects non-array payloads, missing fields and invalid timestamps', () => {
        assert.equal(
            evnResponseSchema.safeParse([{ prekinID: 'incomplete' }]).success,
            false,
        );
        assert.equal(
            evnResponseSchema.safeParse([{ ...evnItem, pocetok: 'not-a-date' }])
                .success,
            false,
        );
        assert.equal(evnResponseSchema.safeParse({}).success, false);
    });
});

describe('vodovodSkopjeResponseSchema', () => {
    const feature = {
        attributes: {
            idINT: 2,
            Opstina: 'Карпош',
            Ulica: 'Тест',
            vidDefektName: 'Дефект',
            status: 0,
            acceptanceDate: 1_761_000_000_000,
            statusVreme: null,
            datumZatvorenaVoda: 0,
        },
        geometry: null,
    };

    it('parses ArcGIS features and transforms epoch millis into Dates', () => {
        const vodovod = vodovodSkopjeResponseSchema.parse({
            features: [feature],
        });
        assert.ok(
            at(vodovod.features, 0).attributes.acceptanceDate instanceof Date,
        );
        assert.equal(
            at(vodovod.features, 0).attributes.datumZatvorenaVoda,
            null,
        );
    });

    it('rejects payloads without features or with invalid attributes', () => {
        assert.equal(vodovodSkopjeResponseSchema.safeParse({}).success, false);
        assert.equal(
            vodovodSkopjeResponseSchema.safeParse({
                features: [
                    {
                        attributes: {
                            idINT: 2,
                            Ulica: 'Тест',
                            vidDefektName: 'Дефект',
                            status: 0,
                            acceptanceDate: 1,
                        },
                    },
                ],
            }).success,
            false,
        );
        assert.equal(
            vodovodSkopjeResponseSchema.safeParse({
                features: [
                    {
                        ...feature,
                        attributes: {
                            ...feature.attributes,
                            acceptanceDate: 'soon',
                        },
                    },
                ],
            }).success,
            false,
        );
    });
});

describe('moeppStationsResponseSchema', () => {
    it('parses station metadata arrays', () => {
        assert.equal(at(moeppStationsResponseSchema.parse([station]), 0).id, 7);
    });

    it('rejects stations with wrong primitive types or missing fields', () => {
        assert.equal(
            moeppStationsResponseSchema.safeParse([
                { ...station, isActive: 'yes' },
            ]).success,
            false,
        );
        assert.equal(
            moeppStationsResponseSchema.safeParse([
                { ...station, longitude: '21.46' },
            ]).success,
            false,
        );
        assert.equal(
            moeppStationsResponseSchema.safeParse([
                { ...station, pollutants: undefined },
            ]).success,
            false,
        );
    });
});

describe('moeppMeasurementsResponseSchema', () => {
    it('parses hourly measurement arrays with nullable pollutant cells', () => {
        const result = moeppMeasurementsResponseSchema.parse([measurement]);
        assert.equal(result.length, 1);
        assert.equal(at(result, 0).pM10_Value, 88);
        assert.equal(at(result, 0).sO2_Index, null);
    });

    it('rejects string values, incomplete index objects and missing fields', () => {
        assert.equal(
            moeppMeasurementsResponseSchema.safeParse([
                { ...measurement, aQ_Value: '88' },
            ]).success,
            false,
        );
        assert.equal(
            moeppMeasurementsResponseSchema.safeParse([
                { ...measurement, aQ_Index: { code: '04' } },
            ]).success,
            false,
        );
        assert.equal(
            moeppMeasurementsResponseSchema.safeParse([
                { ...measurement, fromTime: undefined },
            ]).success,
            false,
        );
    });
});

describe('amsmFuelResponseSchema', () => {
    it('parses fuel posts and coerces string prices to numbers', () => {
        const result = amsmFuelResponseSchema.parse([fuel]);
        assert.equal(at(result, 0).acf.petrol95, 78.5);
        assert.equal(at(result, 0).acf.diesel, 71);
    });

    it('rejects non-positive or non-numeric prices and missing acf blocks', () => {
        assert.equal(
            amsmFuelResponseSchema.safeParse([
                { ...fuel, acf: { ...fuel.acf, diesel: 0 } },
            ]).success,
            false,
        );
        assert.equal(
            amsmFuelResponseSchema.safeParse([
                { ...fuel, acf: { ...fuel.acf, petrol95: 'cheap' } },
            ]).success,
            false,
        );
        assert.equal(
            amsmFuelResponseSchema.safeParse([{ id: 55 }]).success,
            false,
        );
    });
});

describe('meteoalarmResponseSchema', () => {
    it('parses CAP alert wrappers and coerces onset/expires timestamps', () => {
        const warnings = meteoalarmResponseSchema.parse({
            warnings: [alert],
        }).warnings;
        assert.equal(warnings.length, 1);
        const info = at(present(at(warnings, 0).alert.info), 0);
        assert.ok(present(info.onset) instanceof Date);
        assert.ok(present(info.expires) instanceof Date);
    });

    it('rejects alerts without areas, info blocks, identifiers or sent stamps', () => {
        const base = alert.alert;
        assert.equal(
            meteoalarmResponseSchema.safeParse({
                warnings: [
                    {
                        uuid: 'u-1',
                        alert: {
                            ...base,
                            info: [{ ...at(base.info, 0), area: [] }],
                        },
                    },
                ],
            }).success,
            false,
        );
        assert.equal(
            meteoalarmResponseSchema.safeParse({
                warnings: [{ uuid: 'u-1', alert: { ...base, info: [] } }],
            }).success,
            false,
        );
        assert.equal(
            meteoalarmResponseSchema.safeParse({
                warnings: [
                    {
                        uuid: 'u-1',
                        alert: {
                            sender: base.sender,
                            sent: base.sent,
                            status: base.status,
                            msgType: base.msgType,
                            info: base.info,
                        },
                    },
                ],
            }).success,
            false,
        );
        assert.equal(
            meteoalarmResponseSchema.safeParse({
                warnings: [
                    { uuid: 'u-1', alert: { ...base, sent: 'not-a-date' } },
                ],
            }).success,
            false,
        );
    });
});

describe('sensorCommunityResponseSchema', () => {
    it('parses packets and coerces numeric strings in coordinates and readings', () => {
        const result = at(sensorCommunityResponseSchema.parse([sensor]), 0);
        assert.equal(result.location.latitude, 42);
        assert.equal(at(result.sensordatavalues, 0).value, 60);
    });

    it('rejects non-numeric indoor flags, missing countries and incomplete sensors', () => {
        assert.equal(
            sensorCommunityResponseSchema.safeParse([
                {
                    ...sensor,
                    location: { ...sensor.location, indoor: '0' },
                },
            ]).success,
            false,
        );
        assert.equal(
            sensorCommunityResponseSchema.safeParse([
                {
                    ...sensor,
                    location: { ...sensor.location, country: undefined },
                },
            ]).success,
            false,
        );
        assert.equal(
            sensorCommunityResponseSchema.safeParse([
                {
                    ...sensor,
                    sensor: {
                        id: 1,
                        sensor_type: { id: 14, name: 'SDS011' },
                    },
                },
            ]).success,
            false,
        );
    });
});

describe('emscResponseSchema', () => {
    it('parses GeoJSON feature collections and coerces quake metadata', () => {
        const result = at(
            emscResponseSchema.parse({ features: [emscFeature] }).features,
            0,
        );
        assert.ok(result.properties.time instanceof Date);
        assert.equal(result.properties.mag, 2.5);
        assert.equal(result.properties.lon, 21.227);
    });

    it('rejects non-Point geometries, short coordinate tuples and missing properties', () => {
        assert.equal(
            emscResponseSchema.safeParse({
                features: [
                    {
                        ...emscFeature,
                        geometry: {
                            type: 'LineString',
                            coordinates: [21.227, 41.435, -15],
                        },
                    },
                ],
            }).success,
            false,
        );
        assert.equal(
            emscResponseSchema.safeParse({
                features: [
                    {
                        ...emscFeature,
                        geometry: {
                            type: 'Point',
                            coordinates: [21.227, 41.435],
                        },
                    },
                ],
            }).success,
            false,
        );
        assert.equal(
            emscResponseSchema.safeParse({
                features: [
                    {
                        ...emscFeature,
                        properties: {
                            ...emscFeature.properties,
                            unid: undefined,
                        },
                    },
                ],
            }).success,
            false,
        );
        assert.equal(emscResponseSchema.safeParse({}).success, false);
    });
});

describe('vodovodKumanovoResponseSchema', () => {
    it('parses WordPress post arrays', () => {
        assert.equal(
            at(vodovodKumanovoResponseSchema.parse([kumanovoPost]), 0).id,
            8015,
        );
    });

    it('rejects string ids, missing titles and missing content blocks', () => {
        assert.equal(
            vodovodKumanovoResponseSchema.safeParse([
                { ...kumanovoPost, id: '8015' },
            ]).success,
            false,
        );
        assert.equal(
            vodovodKumanovoResponseSchema.safeParse([
                { ...kumanovoPost, title: undefined },
            ]).success,
            false,
        );
        assert.equal(
            vodovodKumanovoResponseSchema.safeParse([
                { ...kumanovoPost, content: undefined },
            ]).success,
            false,
        );
    });
});

describe('vodovodPrilepResponseSchema', () => {
    it('parses posts and treats excerpts as optional', () => {
        assert.equal(
            at(vodovodPrilepResponseSchema.parse([prilepPost]), 0).id,
            7357,
        );
        assert.equal(
            vodovodPrilepResponseSchema.safeParse([
                { ...prilepPost, excerpt: undefined },
            ]).success,
            true,
        );
    });

    it('rejects posts with non-numeric ids or missing required blocks', () => {
        assert.equal(
            vodovodPrilepResponseSchema.safeParse([
                { ...prilepPost, id: '7357' },
            ]).success,
            false,
        );
        assert.equal(
            vodovodPrilepResponseSchema.safeParse([
                { ...prilepPost, link: undefined },
            ]).success,
            false,
        );
        assert.equal(
            vodovodPrilepResponseSchema.safeParse([
                { ...prilepPost, title: undefined },
            ]).success,
            false,
        );
    });
});

describe('worldFiresHotspotsResponseSchema', () => {
    it('parses hotspot collections and coerces numeric strings to numbers', () => {
        const hotspot = at(
            worldFiresHotspotsResponseSchema.parse({
                data: [worldFiresHotspot],
            }).data,
            0,
        );
        assert.ok(hotspot.time_utc instanceof Date);
        assert.equal(hotspot.lat, 42.088);
        assert.equal(hotspot.frp_mw, 12.4);
    });

    it('rejects payloads without data and hotspots with invalid dates or readings', () => {
        assert.equal(
            worldFiresHotspotsResponseSchema.safeParse({}).success,
            false,
        );
        assert.equal(
            worldFiresHotspotsResponseSchema.safeParse({
                data: [{ ...worldFiresHotspot, time_utc: 'not-a-date' }],
            }).success,
            false,
        );
        assert.equal(
            worldFiresHotspotsResponseSchema.safeParse({
                data: [{ ...worldFiresHotspot, frp_mw: 'strong' }],
            }).success,
            false,
        );
        assert.equal(
            worldFiresHotspotsResponseSchema.safeParse({
                data: [{ ...worldFiresHotspot, satellite: undefined }],
            }).success,
            false,
        );
    });
});

describe('iodaSignalsResponseSchema', () => {
    it('parses signal envelopes and error-only envelopes', () => {
        const envelope = iodaSignalsResponseSchema.parse({
            error: null,
            data: [[iodaSeries]],
        });
        assert.equal(envelope.error, null);
        assert.equal(at(at(present(envelope.data), 0), 0).entityCode, 'MK');

        const errorEnvelope = iodaSignalsResponseSchema.parse({
            error: 'invalid datasource',
            data: null,
        });
        assert.equal(errorEnvelope.error, 'invalid datasource');
        assert.equal(errorEnvelope.data, null);
    });

    it('rejects malformed error fields and series with invalid windows or steps', () => {
        assert.equal(
            iodaSignalsResponseSchema.safeParse({ error: 42, data: null })
                .success,
            false,
        );
        assert.equal(
            iodaSignalsResponseSchema.safeParse({ error: null, data: 'oops' })
                .success,
            false,
        );
        assert.equal(
            iodaSignalsResponseSchema.safeParse({
                error: null,
                data: [[{ ...iodaSeries, step: 0 }]],
            }).success,
            false,
        );
        assert.equal(
            iodaSignalsResponseSchema.safeParse({
                error: null,
                data: [[{ ...iodaSeries, from: 1.5 }]],
            }).success,
            false,
        );
        assert.equal(
            iodaSignalsResponseSchema.safeParse({
                error: null,
                data: [[{ ...iodaSeries, values: undefined }]],
            }).success,
            false,
        );
    });
});

describe('nbrmRatesResponseSchema', () => {
    it('validates a rates array with integer counters and positive middle rate', () => {
        const result = nbrmRatesResponseSchema.parse([
            nbrmRate,
            {
                ...nbrmRate,
                rBr: 2,
                oznaka: 'USD',
                nomin: 1,
                sreden: 56.5,
            },
        ]);
        assert.equal(at(result, 0).rBr, 1);
        assert.equal(at(result, 0).nomin, 1);
        assert.equal(at(result, 0).sreden, 61.7234);
        assert.equal(at(result, 1).oznaka, 'USD');
    });

    it('rejects non-positive rBr', () => {
        assert.equal(
            nbrmRatesResponseSchema.safeParse([{ ...nbrmRate, rBr: 0 }])
                .success,
            false,
        );
    });

    it('rejects non-positive nomin', () => {
        assert.equal(
            nbrmRatesResponseSchema.safeParse([{ ...nbrmRate, nomin: 0 }])
                .success,
            false,
        );
    });

    it('rejects non-positive sreden', () => {
        assert.equal(
            nbrmRatesResponseSchema.safeParse([{ ...nbrmRate, sreden: 0 }])
                .success,
            false,
        );
    });

    it('rejects empty oznaka', () => {
        assert.equal(
            nbrmRatesResponseSchema.safeParse([{ ...nbrmRate, oznaka: '' }])
                .success,
            false,
        );
    });

    it('rejects items with missing required fields', () => {
        assert.equal(
            nbrmRatesResponseSchema.safeParse([
                {
                    rBr: 1,
                    datum: '2026-11-17',
                    oznaka: 'EUR',
                },
            ]).success,
            false,
        );
    });
});

describe('opstinaVelesResponseSchema', () => {
    it('parses WordPress posts with date_gmt', () => {
        assert.equal(
            at(opstinaVelesResponseSchema.parse([velesPost]), 0).id,
            5011,
        );
    });

    it('rejects string ids, missing date_gmt and missing content blocks', () => {
        assert.equal(
            opstinaVelesResponseSchema.safeParse([{ ...velesPost, id: '5011' }])
                .success,
            false,
        );
        assert.equal(
            opstinaVelesResponseSchema.safeParse([
                { ...velesPost, date_gmt: undefined },
            ]).success,
            false,
        );
        assert.equal(
            opstinaVelesResponseSchema.safeParse([
                { ...velesPost, content: undefined },
            ]).success,
            false,
        );
    });
});

describe('opstinaIlindenResponseSchema', () => {
    it('parses WordPress posts with date_gmt', () => {
        assert.equal(
            at(opstinaIlindenResponseSchema.parse([ilindenPost]), 0).id,
            3785,
        );
    });

    it('rejects string ids, missing date_gmt and missing content blocks', () => {
        assert.equal(
            opstinaIlindenResponseSchema.safeParse([
                { ...ilindenPost, id: '3785' },
            ]).success,
            false,
        );
        assert.equal(
            opstinaIlindenResponseSchema.safeParse([
                { ...ilindenPost, date_gmt: undefined },
            ]).success,
            false,
        );
        assert.equal(
            opstinaIlindenResponseSchema.safeParse([
                { ...ilindenPost, content: undefined },
            ]).success,
            false,
        );
    });
});

describe('opstinaDebrcaResponseSchema', () => {
    it('parses WordPress posts with date_gmt', () => {
        assert.equal(
            at(opstinaDebrcaResponseSchema.parse([debrcaPost]), 0).id,
            10378,
        );
    });

    it('rejects string ids, missing date_gmt and missing content blocks', () => {
        assert.equal(
            opstinaDebrcaResponseSchema.safeParse([
                { ...debrcaPost, id: '10378' },
            ]).success,
            false,
        );
        assert.equal(
            opstinaDebrcaResponseSchema.safeParse([
                { ...debrcaPost, date_gmt: undefined },
            ]).success,
            false,
        );
        assert.equal(
            opstinaDebrcaResponseSchema.safeParse([
                { ...debrcaPost, content: undefined },
            ]).success,
            false,
        );
        assert.equal(opstinaDebrcaResponseSchema.safeParse({}).success, false);
    });
});
