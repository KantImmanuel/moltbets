FROM node:20-slim

WORKDIR /app

# Copy package files and npmrc
COPY package.json package-lock.json .npmrc ./

# Install deps (legacy-peer-deps via .npmrc)
RUN npm ci --legacy-peer-deps

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

CMD ["node", "dist/index.js"]
