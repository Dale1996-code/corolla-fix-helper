FROM node:22-bookworm AS build
WORKDIR /app

ENV NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false

COPY package.json package-lock.json ./
RUN npm ci

COPY server/package.json server/package-lock.json ./server/
RUN npm ci --prefix server

COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client

COPY . .

RUN npm run build:client
RUN npm prune --omit=dev --prefix server


FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000

COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist

EXPOSE 4000

CMD ["node", "server/src/index.js"]
