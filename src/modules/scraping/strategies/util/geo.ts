export function formatEwktPoint(lng: number, lat: number): string {
    return `SRID=4326;POINT(${lng} ${lat})`;
}
