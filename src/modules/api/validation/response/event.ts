import { createSelectSchema } from 'drizzle-zod';
import type { z } from 'zod';
import { type EventItem, events } from '../../../../core/schema.js';

export const eventDtoSchema = createSelectSchema(events).omit({
    rawPayload: true,
    scrapedAt: true,
    updatedAt: true,
});

export type EventDto = z.infer<typeof eventDtoSchema>;

export function toEventDto(row: EventItem): EventDto {
    return eventDtoSchema.parse(row);
}
