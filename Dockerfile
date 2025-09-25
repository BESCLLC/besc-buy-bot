FROM node:20.11.1-slim AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["npm", "start"]
