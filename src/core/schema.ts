import { pgTable, text } from 'drizzle-orm/pg-core';

export const temp = pgTable('temp', {
    id: text('id').primaryKey(),
});
