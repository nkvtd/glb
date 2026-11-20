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

export const velesPost = {
    id: 5011,
    date: '2026-11-18T09:10:00',
    date_gmt: '2026-11-18T08:10:00',
    link: 'https://www.veles.gov.mk/izvestuvanje-5011/',
    title: {
        rendered: 'ИЗВЕСТУВАЊЕ',
    },
    content: {
        rendered:
            '<p>Соопштуваме дека на <strong>21 ноември 2026</strong> ќе има прекин во снабдувањето со електрична енергија во периодот од 09:00 до 13:00 часот за корисниците на ул. Мито Хаџивасилев.</p>',
    },
};

export const debrcaPost = {
    id: 10378,
    date: '2026-11-17T15:12:05',
    date_gmt: '2026-11-17T14:12:05',
    link: 'https://debrca.gov.mk/%d0%b8%d0%b7%d0%b2%d0%b5%d1%81%d1%82%d1%83%d0%b2%d0%b0%d1%9a%d0%b5-%d0%b4%d0%be-%d0%bd%d0%b0%d1%81%d0%b5%d0%bb%d0%b5%d0%bd%d0%b8-%d0%bc%d0%b5%d1%81%d1%82%d0%b0-%d0%b0%d1%80%d0%b1%d0%b8%d0%bd%d0%be/',
    title: {
        rendered:
            'Известување до населени места Арбиново и Слатински Чифлик за заматеност за водата за пиење',
    },
    content: {
        rendered:
            '<div dir="auto" data-olk-copy-source="MessageBody">Известување до населени места Арбиново и Слатински Чифлик за заматеност за водата за пиење.</div>\n<div dir="auto"></div>\n<div dir="auto">Се известуваат жителите на с.Арбиново и с.Слатински Чифлик да не ја употребуваат водата за пиење поради појава на матност.</div>\n<div dir="auto"></div>\n<div dir="auto">Со Почит,</div>\n<div dir="auto"></div>\n<div dir="auto" style="text-align: right;">ЈКП ДЕБРЦА</div>',
    },
};

export const ilindenPost = {
    id: 3785,
    date: '2026-08-18T15:24:09',
    date_gmt: '2026-08-18T13:24:09',
    link: 'https://ilinden.gov.mk/%d0%b8%d0%b7%d0%b2%d0%b5%d1%81%d1%82%d1%83%d0%b2%d0%b0%d1%9a%d0%b5-%d0%b7%d0%b0-%d0%b2%d0%be%d0%b4%d0%be%d1%81%d0%bd%d0%b0%d0%b1%d0%b4%d1%83%d0%b2%d0%b0%d1%9a%d0%b5/',
    title: {
        rendered: 'ИЗВЕСТУВАЊЕ ЗА ПРЕКИН ВО ВОДОСНАБДУВАЊЕ',
    },
    content: {
        rendered:
            '<p>Се известуваат корисниците од улиците 1, 2, 3, 4, 5, 6, 7, 24, 26, 28, 30, 32, 34, 35 и 36 во н.м.Илинден, односно од влезот на н.м.Илинден до кружниот тек во н.м.Илинден, н.м.Пуста Кула и економските зони во н.м.Илинден дека на ден 19.08.2026 година (среда) ќе имаат прекин во водоснабдувањето поради изведување на активности во разводна водоводна шахта за поврзување на постоечката главна водоводна линија со новоизградената главна водоводна линија на ул.9 во н.м.Илинден.</p>',
    },
};

export const ohridPost = {
    id: 44410,
    date: '2026-07-29T10:57:17',
    date_gmt: '2026-07-29T08:57:17',
    link: 'https://ohrid.gov.mk/%d0%b8%d0%b7%d0%b2%d0%b5%d1%81%d1%82%d1%83%d0%b2%d0%b0%d1%9a%d0%b5-%d0%b7%d0%b0-%d0%be%d1%82%d1%81%d1%82%d1%80%d0%b0%d0%bd%d1%83%d0%b2%d0%b0%d1%9a%d0%b5-%d0%bd%d0%b0-%d0%bd%d0%b5%d0%bb%d0%b5%d0%b3-cop/',
    title: {
        rendered:
            'ЗАБРАНА ЗА КОРИСТЕЊЕ НА ИЗВОРСКА ВОДА ЗА ПИЕЊЕ ВО ЕЛШАНИ И ВЕЛЕСТОВО',
    },
    content: {
        rendered: [
            '\t\t<div data-elementor-type="wp-post" data-elementor-id="44410" class="elementor elementor-44410">',
            '\t\t\t<section class="elementor-section elementor-top-section">',
            '\t\t\t\t<div class="elementor-widget elementor-widget-jkit_post_date"><div class="elementor-widget-container"><div class="jeg-elementor-kit jkit-post-date"><p class="post-date ">јули 29, 2026</p></div></div></div>',
            '\t\t\t\t<div class="elementor-widget elementor-widget-icon"><div class="elementor-widget-container"><div class="elementor-icon"><svg aria-hidden="true" class="e-font-icon-svg e-far-calendar-alt" viewBox="0 0 448 512" xmlns="http://www.w3.org/2000/svg"><path d="M148 288h-40c-6.6 0-12-5.4-12-12v-40c0-6.6 5.4-12 12-12h40c6.6 0 12 5.4 12 12v40c0 6.6-5.4 12-12 12zm108-12v-40c0-6.6-5.4-12-12-12h-40c-6.6 0-12 5.4-12 12v40c0 6.6 5.4 12 12 12h40c6.6 0 12-5.4 12-12z"></path></svg></div></div></div>',
            '\t\t\t\t<div class="elementor-widget elementor-widget-jkit_post_terms"><div class="elementor-widget-container"><div class="jeg-elementor-kit jkit-post-terms"><span class="post-terms"><span class="term-list ">ВЕСТИ</span></span></div></div></div>',
            '\t\t\t</section>',
            '\t\t\t<section class="elementor-section elementor-top-section">',
            '\t\t\t\t<div class="elementor-widget elementor-widget-heading"><div class="elementor-widget-container"><h2 class="elementor-heading-title elementor-size-default">ЗАБРАНА ЗА КОРИСТЕЊЕ НА ИЗВОРСКА ВОДА ЗА ПИЕЊЕ ВО ЕЛШАНИ И ВЕЛЕСТОВО</h2></div></div>',
            '\t\t\t\t<div class="elementor-widget elementor-widget-text-editor"><div class="elementor-widget-container"><p>По извршените анализи на ЈЗУ &#8220;Центар за јавно здравје Охрид&#8221; од изворите во селата Елшани и Велестово, донесено е решение со кое се забранува водата да се користи за пиење. Лабораториските анализи покажеле присуство на Е.coli и Колиформни бактерии.</p><p>Се задолжуваат месните заедници во Елшани и Велестово да постават јасно и видливо предупредување дека&nbsp;<strong>ВОДАТА НЕ Е ЗА ПИЕЊЕ.</strong></p></div></div>',
            '\t\t\t</section>',
            '\t\t\t<section class="elementor-section elementor-top-section">',
            '\t\t\t\t<div class="elementor-widget elementor-widget-text-editor"><div class="elementor-widget-container">Tags : </div></div>',
            '\t\t\t\t<div class="elementor-widget elementor-widget-heading"><div class="elementor-widget-container"><h2 class="elementor-heading-title elementor-size-default">Најнови објави</h2></div></div>',
            '\t\t\t\t<p>ИЗВЕСТУВАЊЕ ЗА ИНФО ДЕН ОД ОБЛАСТА НА КУЛТУРАТА</p>',
            '\t\t\t</section>',
            '\t\t</div>',
        ].join('\n'),
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
