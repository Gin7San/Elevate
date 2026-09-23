# --- build ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- run ---
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
# ffmpeg reduces each upload to 16 kHz mono audio before transcription. Without
# it the original recording is sent upstream instead (see lib/audioExtract.ts).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
# Full node_modules keeps the prisma CLI available for `migrate deploy` at boot.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
