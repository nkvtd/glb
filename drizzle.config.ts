import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { config } from "./src/core/config.js";

export default defineConfig({
    dialect: "postgresql",
    schema: "./src/core/schema.ts",
    out: "./src/infrastructure/database/migrations",

    dbCredentials: {
        url: config.DATABASE_URL,
    },
});