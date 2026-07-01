FROM node:24-bookworm AS build
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


FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# OCR defaults to on (OCR_ENABLED=true). The backend shells out to Poppler
# (pdftoppm) and Tesseract to read scanned / image-only PDF pages, so install
# both here; without them, scanned PDFs would import with an `ocr_unavailable:`
# status. Text PDFs never need these. Set OCR_ENABLED=false to skip OCR anyway.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4000

COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist

EXPOSE 4000

CMD ["node", "server/src/index.js"]
