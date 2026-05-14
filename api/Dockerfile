FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache wget

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY db ./db

EXPOSE 3000
CMD ["node", "src/index.js"]
