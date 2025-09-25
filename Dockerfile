# Use a pinned Node version (stable + Railway-friendly)
FROM node:20.11.1-alpine AS base

# Set working directory
WORKDIR /app

# Install only prod dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app code
COPY . .

# Set environment
ENV NODE_ENV=production

# Start bot
CMD ["npm", "start"]
