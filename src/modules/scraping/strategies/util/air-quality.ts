export const POOR_AIR_INDEX_CODES: ReadonlySet<string> = new Set([
    '04',
    '05',
    '06',
]);

export function getAirQualityTitlePrefix(
    code: string | undefined,
    fallback?: string,
): string {
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
            return fallback ?? 'Квалитет на воздух (нема податоци)';
    }
}

export function getAirQualityAdjective(
    code: string | undefined,
): string | null {
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
