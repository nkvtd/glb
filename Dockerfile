FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json esbuild.config.js drizzle.config.ts ./
COPY src ./src
COPY data ./data

RUN npm run build


FROM node:24-alpine
RUN apk add --no-cache tzdata

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src/infrastructure/database/migrations ./src/infrastructure/database/migrations
COPY --from=build /app/data ./data

EXPOSE 8080

CMD ["npm", "run", "start:server"]