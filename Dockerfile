# Build stage
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY --from=builder /app/build ./build
COPY databases.json ./

EXPOSE 3030

ENV START_MODE=rest
CMD ["node", "build/index.js"]
