import PQueue from 'p-queue';
import { AlertDispatcher } from './infrastructure/alerting/dispatcher.js';
import { db, pool } from './infrastructure/database/db.js';
import { logger } from './infrastructure/logging/logger.js';
import { ScrapingOrchestrator } from './modules/scraping/orchestrator.js';
import { MunicipalityResolver } from './modules/scraping/resolver.js';
import { AmsmFuelStrategy } from './modules/scraping/strategies/amsm-fuel.strategy.js';
import { EmscStrategy } from './modules/scraping/strategies/emsc.strategy.js';
import { EvnStrategy } from './modules/scraping/strategies/evn.strategy.js';
import { IodaEventsStrategy } from './modules/scraping/strategies/ioda-events.strategy.js';
import { IodaReportsStrategy } from './modules/scraping/strategies/ioda-reports.strategy.js';
import { MeteoalarmStrategy } from './modules/scraping/strategies/meteoalarm.strategy.js';
import { MoeppStrategy } from './modules/scraping/strategies/moepp.strategy.js';
import { NbrmRatesStrategy } from './modules/scraping/strategies/nbrm-rates.strategy.js';
import { OpstinaDebrcaStrategy } from './modules/scraping/strategies/opstina-debrca.strategy.js';
import { OpstinaIlindenStrategy } from './modules/scraping/strategies/opstina-ilinden.strategy.js';
import { OpstinaOhridStrategy } from './modules/scraping/strategies/opstina-ohrid.strategy.js';
import { OpstinaVelesStrategy } from './modules/scraping/strategies/opstina-veles.strategy.js';
import { SensorCommunityStrategy } from './modules/scraping/strategies/sensor-community.strategy.js';
import { VodovodKumanovoStrategy } from './modules/scraping/strategies/vodovod-kumanovo.strategy.js';
import { VodovodPrilepStrategy } from './modules/scraping/strategies/vodovod-prilep.strategy.js';
import { VodovodSkopjeStrategy } from './modules/scraping/strategies/vodovod-skopje.strategy.js';
import { WorldFiresStrategy } from './modules/scraping/strategies/worldfires.strategy.js';

async function main() {
    logger.info('[Worker] starting...');

    const resolver = new MunicipalityResolver(db);
    await resolver.init();

    const dispatcher = new AlertDispatcher();
    await dispatcher.init();

    const queue = new PQueue({ concurrency: 4 });

    const strategies = [
        new EvnStrategy(
            'https://portal-api.elektrodistribucija.mk/DSO/Prekini/ZemiPrekini',
            '*/30 * * * *',
            resolver,
        ),
        new VodovodSkopjeStrategy(
            'https://gis.vodovod.com.mk/arcgis/rest/services/Dashboard/Defekti/MapServer/dynamicLayer/query?f=json&where=acceptanceDate%20BETWEEN%20(CURRENT_DATE%20-%207)%20AND%20(CURRENT_DATE%20%2B%201)&returnGeometry=true&outFields=idINT,archiveNumber,Opstina,Ulica,adresaBrojDefekt,lokacija,vidDefektId,vidDefektName,vidIntervencijaId,vidIntervencijaName,defectInfo,itnostString,izvesteniPrekin,status,statusVreme,acceptanceDate,datumZatvorenaVoda,datumPustenaVoda,zatvorenaVodaTip,prekinStrujaHidrofor,naprevenUvid,title&outSR=4326&layer=%7B%22source%22%3A%7B%22type%22%3A%22mapLayer%22%2C%22mapLayerId%22%3A0%7D%7D',
            '*/30 * * * *',
            resolver,
        ),
        new MoeppStrategy(
            'https://air.moepp.gov.mk/api/data',
            '*/30 * * * *',
            resolver,
        ),
        new AmsmFuelStrategy(
            'https://amsm.mk/wp-json/wp/v2/cena-goriva?slug=makedonija',
            '0 */2 * * *',
        ),
        new MeteoalarmStrategy(
            'https://feeds.meteoalarm.org/api/v1/warnings/feeds-republic-of-north-macedonia',
            '*/15 * * * *',
            resolver,
        ),
        new SensorCommunityStrategy(
            'https://data.sensor.community/airrohr/v1/filter/country=MK',
            '*/15 * * * *',
            resolver,
        ),
        new EmscStrategy(
            'https://www.seismicportal.eu/fdsnws/event/1/query?limit=1000&minlat=40.8&maxlat=42.4&minlon=20.4&maxlon=23.0&format=json&minmag=2.0',
            '*/10 * * * *',
            resolver,
        ),
        new VodovodKumanovoStrategy(
            'https://vodovod-kumanovo.com.mk/wp-json/wp/v2/posts?categories=3&per_page=14&_fields=id,date,link,title,content',
            '*/30 * * * *',
        ),
        new VodovodPrilepStrategy(
            'https://vodovod-prilep.mk/wp-json/wp/v2/posts?per_page=14&_fields=id,date,link,title,excerpt,content',
            '*/30 * * * *',
        ),
        new NbrmRatesStrategy(
            'https://www.nbrm.mk/KLServiceNOV/GetExchangeRate',
            '5 0 * * *',
        ),
        new WorldFiresStrategy(
            'https://worldfires.org/api/v1/hotspots?bbox=40.8,20.4,42.4,23.0&hours=24',
            '*/15 * * * *',
            resolver,
        ),
        new IodaEventsStrategy(
            'https://api.ioda.inetintel.cc.gatech.edu/v2',
            '*/10 * * * *',
        ),
        new IodaReportsStrategy(
            'https://api.ioda.inetintel.cc.gatech.edu/v2',
            '*/10 * * * *',
            resolver,
        ),
        new OpstinaVelesStrategy(
            'https://www.veles.gov.mk/wp-json/wp/v2/posts?categories=42&per_page=50&_fields=id,date,date_gmt,link,title,content',
            '*/30 * * * *',
            'water',
        ),
        new OpstinaVelesStrategy(
            'https://www.veles.gov.mk/wp-json/wp/v2/posts?categories=42&per_page=50&_fields=id,date,date_gmt,link,title,content',
            '*/31 * * * *',
            'road',
        ),
        new OpstinaDebrcaStrategy(
            'https://debrca.gov.mk/wp-json/wp/v2/posts?categories=50&per_page=20&_fields=id,date,date_gmt,link,title,content',
            '*/30 * * * *',
        ),
        new OpstinaIlindenStrategy(
            'https://ilinden.gov.mk/wp-json/wp/v2/posts?categories=12&per_page=100&_fields=id,date,date_gmt,link,title,content',
            '*/30 * * * *',
            'water',
        ),
        new OpstinaIlindenStrategy(
            'https://ilinden.gov.mk/wp-json/wp/v2/posts?categories=12&per_page=100&_fields=id,date,date_gmt,link,title,content',
            '*/31 * * * *',
            'road',
        ),
        new OpstinaOhridStrategy(
            'https://ohrid.gov.mk/wp-json/wp/v2/posts?categories=10&per_page=100&_fields=id,date,date_gmt,link,title,content',
            '*/30 * * * *',
            'water',
        ),
        new OpstinaOhridStrategy(
            'https://ohrid.gov.mk/wp-json/wp/v2/posts?categories=10&per_page=100&_fields=id,date,date_gmt,link,title,content',
            '*/31 * * * *',
            'road',
        ),
    ];

    const orchestrator = new ScrapingOrchestrator(
        db,
        strategies,
        dispatcher,
        queue,
    );
    orchestrator.start();

    const shutdown = async () => {
        logger.info('[Worker] shutting down...');

        orchestrator.stop();
        await pool.end();
        logger.close();
        process.exit(0);
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

main().catch((error) => {
    logger.error('[Worker] failed to start:\n%O', error);
    process.exit(1);
});
