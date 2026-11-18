// Canonical upstream wire fixtures shared across test suites. Clone or spread
// before customizing so the canonical shapes stay immutable and isolated.
const index = { code: '04', color: '#f00', name: 'Лош', nameEN: 'Poor' };

export const station = {
    id: 7,
    code: 'SK1',
    name: 'Лисиче',
    longitude: 21.46,
    latitude: 41.97,
    isActive: true,
    created: '2020-01-01',
    regionID: 8,
    city: 'Скопје - Аеродром',
    typeOfStation: 'Background',
    areaType: 'Urban',
    address: 'Лисиче',
    altituda: 240,
    pollutants: 'PM10,PM25',
    cityEN: 'Skopje',
    addressEN: 'Lisice',
    areaTypeEN: 'Urban',
    typeOfStationEN: 'Background',
    nameEN: 'Lisice',
};

export const measurement = {
    stationID: 7,
    stationName: 'Лисиче',
    stationNameEN: 'Lisice',
    fromTime: '2026-10-25T08:00:00',
    toTime: '2026-10-25T09:00:00',
    aQ_Value: 88,
    aQ_Index: index,
    cO_Value: null,
    cO_Index: null,
    nO2_Value: null,
    nO2_Index: null,
    o3_Value: null,
    o3_Index: null,
    pM25_Value: 42,
    pM25_Index: index,
    pM10_Value: 88,
    pM10_Index: index,
    sO2_Value: null,
    sO2_Index: null,
};

export const fuel = {
    id: 55,
    date: '2026-10-25T00:00:00',
    date_gmt: '2026-10-25T00:00:00',
    modified: '2026-10-25T00:00:00',
    modified_gmt: '2026-10-25T00:00:00',
    slug: 'makedonija',
    status: 'publish',
    type: 'cena-goriva',
    link: 'https://amsm.mk',
    title: { rendered: 'Македонија' },
    acf: {
        gas_uid: 'mk',
        gas_country: 'Македонија',
        gas_currency: 'МКД',
        petrol95: '78.5',
        petrol98: 80.5,
        diesel: 71,
        petrol95eur: 1.276,
        petrol98eur: 1.308,
        dieseleur: 1.154,
        gas_last_update: '2026-10-24',
    },
};

export const alert = {
    uuid: 'u-1',
    alert: {
        identifier: 'alert-1',
        sender: 'uhmr@example.test',
        sent: '2026-10-25T08:00:00Z',
        status: 'Actual',
        msgType: 'Alert',
        info: [
            {
                language: 'en-GB',
                event: 'Thunderstorm',
                onset: '2026-10-25T08:00:00Z',
                expires: '2026-10-25T12:00:00Z',
                parameter: [],
                area: [{ areaDesc: 'Skopje', geocode: [] }],
            },
        ],
    },
};

export const sensor = {
    id: 1,
    timestamp: '2026-10-25 10:15:00',
    sensor: {
        id: 1,
        sensor_type: { id: 14, name: 'SDS011', manufacturer: 'Nova' },
    },
    location: {
        id: 1,
        latitude: '42.0',
        longitude: '21.42',
        altitude: '250',
        country: 'MK',
        indoor: 0,
    },
    sensordatavalues: [
        { value_type: 'P1', value: '60' },
        { value_type: 'P2', value: 30 },
    ],
};

export const emscFeature = {
    type: 'Feature',
    geometry: {
        type: 'Point',
        coordinates: [21.227, 41.435, -15],
    },
    id: '20261017_0000107',
    properties: {
        source_id: '2076106',
        source_catalog: 'EMSC-RTS',
        lastupdate: '2026-10-17T08:29:38.08296Z',
        time: '2026-10-17T08:15:36.3Z',
        flynn_region: 'REPUBLIC OF NORTH MACEDONIA',
        lat: 41.435,
        lon: 21.227,
        depth: 15,
        evtype: 'ke',
        auth: 'IGEO',
        mag: 2.5,
        magtype: 'ml',
        unid: '20261017_0000107',
    },
};

export const kumanovoPost = {
    id: 8015,
    date: '2026-10-22T07:54:14',
    link: 'https://vodovod-kumanovo.com.mk/post-8015/',
    title: {
        rendered:
            'Дефекти и интервенции на водоводна мрежа на ден 22.10.2026год.',
    },
    content: {
        rendered:
            '<ul><li>ул. 114 бр. 6, нас. Карпош &#8211; дефект на водоводна мрежа.</li></ul>',
    },
};

export const prilepPost = {
    id: 7357,
    date: '2026-11-05T08:49:45',
    link: 'https://vodovod-prilep.mk/post-7357/',
    title: {
        rendered: 'ВОДОСНАБДУВАЊЕТО НА ОПШТИНА ПРИЛЕП',
    },
    excerpt: {
        rendered: '<p>Водоснабдувањето на ден 05.11.2026 [&hellip;]</p>',
    },
    content: {
        rendered:
            '<p>Водоснабдувањето на ден 05.11.2026 ќе биде нормално.</p><h2>Прекин во водоснабдувањето заради санација на дефекти и приклучоци во периодот од 08 до 14 часот ќе има на следните улици и делови од Општина Прилеп:</h2><h2>– ул. Лазо Филипоски</h2>',
    },
};

export const worldFiresHotspot = {
    time_utc: '2026-11-08T12:08:00Z',
    lat: '42.088',
    lon: '21.712',
    frp_mw: '12.4',
    satellite: '  NOAA-20 ',
    sensor: 'viirs',
};

export const iodaSeries = {
    entityType: 'country',
    entityCode: 'MK',
    entityName: 'North Macedonia',
    datasource: 'bgp',
    from: 1_762_000_000,
    until: 1_762_001_800,
    step: 300,
    values: [100, null, 90],
};

export const nbrmRate = {
    rBr: 1,
    datum: '2026-11-17',
    valuta: 'EUR',
    oznaka: 'EUR',
    drzava: 'ЕМИ',
    nomin: 1,
    sreden: 61.7234,
    nazivMak: 'Евро',
    datum_f: '17.11.2026',
};
