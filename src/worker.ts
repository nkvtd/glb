import { AlertDispatcher } from './infrastructure/alerting/dispatcher.js';
import { db, pool } from './infrastructure/database/db.js';
import { logger } from './infrastructure/logging/logger.js';
import { ScrapingOrchestrator } from './modules/scraping/orchestrator.js';
import { MunicipalityResolver } from './modules/scraping/resolver.js';
import { EvnStrategy } from './modules/scraping/strategies/evn.strategy.js';
import { VodovodSkopjeStrategy } from './modules/scraping/strategies/vodovod-skopje.strategy.js';

async function main() {
    logger.info('[Worker] starting...');

    const resolver = new MunicipalityResolver(db);
    await resolver.init();

    const dispatcher = new AlertDispatcher();
    await dispatcher.init();

    const strategies = [
        new EvnStrategy(
            'https://portal-api.elektrodistribucija.mk/DSO/Prekini/ZemiPrekini',
            '*/30 * * * *',
            resolver,
        ),
        new VodovodSkopjeStrategy(
            'https://gis.vodovod.com.mk/arcgis/rest/services/Dashboard/Defekti/MapServer/dynamicLayer/query?f=json&where=acceptanceDate%20BETWEEN%20(CURRENT_DATE%20-%2030)%20AND%20(CURRENT_DATE%20%2B%201)&returnGeometry=true&outFields=idINT,archiveNumber,Opstina,Ulica,adresaBrojDefekt,lokacija,vidDefektId,vidDefektName,vidIntervencijaId,vidIntervencijaName,defectInfo,itnostString,izvesteniPrekin,status,statusVreme,acceptanceDate,datumZatvorenaVoda,datumPustenaVoda,zatvorenaVodaTip,prekinStrujaHidrofor,naprevenUvid,title&outSR=4326&layer=%7B%22source%22%3A%7B%22type%22%3A%22mapLayer%22%2C%22mapLayerId%22%3A0%7D%7D',
            '*/30 * * * *',
            resolver,
        ),
    ];

    const orchestrator = new ScrapingOrchestrator(db, strategies, dispatcher);
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
