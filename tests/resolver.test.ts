import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MunicipalityResolver } from '../src/modules/scraping/resolver.js';
import { createResolverDb, type ResolverRow } from './util/fakes.js';

const rows: ResolverRow[] = [
    {
        code: 'MK0080907',
        nameMk: 'Карпош',
        nameEn: 'Karposh',
        regionCode: 'MK008',
    },
    {
        code: 'MK0080904',
        nameMk: 'Гази Баба',
        nameEn: 'Gazi Baba',
        regionCode: 'MK008',
    },
    {
        code: 'MK0080999',
        nameMk: 'Гази Баба Центар',
        nameEn: 'Gazi Baba Center',
        regionCode: 'MK008',
    },
    {
        code: 'MK0021100',
        nameMk: 'Штип',
        nameEn: 'Shtip',
        regionCode: 'MK002',
    },
    {
        code: 'MK0021000',
        nameMk: 'Чешиново - Облешево',
        nameEn: 'Cheshinovo - Obleshevo',
        regionCode: 'MK002',
    },
    {
        code: 'MK0081600',
        nameMk: 'Чучер - Сандево',
        nameEn: 'Chucher - Sandevo',
        regionCode: 'MK008',
    },
    {
        code: 'MK0041000',
        nameMk: 'Струмица',
        nameEn: 'Strumitsa',
        regionCode: 'MK004',
    },
    {
        code: 'MK0060700',
        nameMk: 'Маврово и Ростуша',
        nameEn: 'Mavrovo and Rostusha',
        regionCode: 'MK006',
    },
    {
        code: 'MK0080906',
        nameMk: 'Ѓорче Петров',
        nameEn: 'Gjorche Petrov',
        regionCode: 'MK008',
    },
];

describe('MunicipalityResolver', () => {
    it('loads normalized aliases once and resolves exact, segment, substring, and region matches', async () => {
        const mock = createResolverDb(rows);
        const resolver = new MunicipalityResolver(mock.db);
        await resolver.init();
        await resolver.init();

        assert.equal(mock.selectCount, 1);
        assert.equal(resolver.resolveText('Карпош'), 'MK0080907');
        assert.equal(resolver.resolveText('karposh'), 'MK0080907');
        assert.equal(resolver.resolveText('Štip'), 'MK0021100');
        assert.equal(resolver.resolveText('Češinovo-Obleševo'), 'MK0021000');
        assert.equal(resolver.resolveText('Cucer Sandevo'), 'MK0081600');
        assert.equal(resolver.resolveText('Strumica'), 'MK0041000');
        assert.equal(resolver.resolveText('Mavrovo and Rostusa'), 'MK0060700');
        assert.equal(resolver.resolveText('Ǵorče Petrov'), 'MK0080906');
        assert.equal(resolver.resolveText('Gjorce Petrov'), 'MK0080906');
        assert.equal(resolver.resolveText('АЕРОДРОМ - ГАЗИ БАБА'), 'MK0080904');
        assert.equal(
            resolver.resolveText('адреса кај Гази Баба Центар'),
            'MK0080999',
        );
        assert.equal(resolver.resolveText('непозната локација'), null);
        assert.equal(resolver.resolveText('   '), null);
        assert.equal(resolver.resolveText(null), null);
        assert.deepEqual(resolver.resolveRegion(' mk008 '), [
            { code: 'MK0080907', nameMk: 'Карпош' },
            { code: 'MK0080904', nameMk: 'Гази Баба' },
            { code: 'MK0080999', nameMk: 'Гази Баба Центар' },
            { code: 'MK0081600', nameMk: 'Чучер - Сандево' },
            { code: 'MK0080906', nameMk: 'Ѓорче Петров' },
        ]);
        assert.deepEqual(resolver.resolveRegion('unknown'), []);
    });

    it('validates coordinates and memoizes coordinate hits and misses', async () => {
        const mock = createResolverDb(rows);
        const resolver = new MunicipalityResolver(mock.db);
        await resolver.init();
        const afterInit = mock.selectCount;

        assert.equal(await resolver.resolveCoords(null, 42), null);
        assert.equal(await resolver.resolveCoords(Number.NaN, 42), null);
        assert.equal(
            await resolver.resolveCoords(Number.POSITIVE_INFINITY, 42),
            null,
        );
        assert.equal(mock.selectCount, afterInit);

        mock.setCoordinateRows([{ code: 'MK0080907', name: 'Карпош' }]);
        assert.deepEqual(await resolver.resolveCoords(21.42, 42), {
            code: 'MK0080907',
            name: 'Карпош',
        });
        assert.deepEqual(await resolver.resolveCoords(21.42, 42), {
            code: 'MK0080907',
            name: 'Карпош',
        });
        assert.equal(mock.selectCount, afterInit + 1);

        mock.setCoordinateRows([]);
        assert.equal(await resolver.resolveCoords(21.43, 42), null);
        assert.equal(await resolver.resolveCoords(21.43, 42), null);
        assert.equal(mock.selectCount, afterInit + 2);
    });
});
