FROM node:20-slim

WORKDIR /app

# Copy package files first for caching
COPY package.json package-lock.json ./

# Install all deps (not just production)
RUN npm ci

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

CMD ["node", "dist/index.js"]
