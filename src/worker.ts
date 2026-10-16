import { AlertDispatcher } from './infrastructure/alerting/dispatcher.js';
import { db, pool } from './infrastructure/database/db.js';
import { logger } from './infrastructure/logging/logger.js';
import { ScrapingOrchestrator } from './modules/scraping/orchestrator.js';
import { MunicipalityResolver } from './modules/scraping/resolver.js';
import { EvnStrategy } from './modules/scraping/strategies/evn.strategy.js';

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
