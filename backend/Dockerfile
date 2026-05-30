FROM node:20-alpine AS build
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm ci

COPY backend/ ./
RUN npx prisma generate && npm run build

FROM node:20-alpine AS runtime
WORKDIR /app/backend

COPY --from=build /app/backend/package*.json ./
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/prisma ./prisma

EXPOSE 4000
CMD ["node", "dist/index.js"]
