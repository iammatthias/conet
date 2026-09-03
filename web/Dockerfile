FROM oven/bun:1.3.14-alpine AS build
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts vite.embed.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.14-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server.ts tsconfig.json ./
COPY src/server ./src/server
COPY src/numbers.ts ./src/numbers.ts
COPY --from=build /build/dist ./dist
USER bun
EXPOSE 3000
CMD ["bun", "server.ts"]
