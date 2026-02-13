FROM node:22-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

FROM base AS production
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist dist/
COPY sql/ sql/

ENV NODE_ENV=production
ENV NODE_TYPE=web
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
