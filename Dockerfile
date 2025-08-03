FROM node:18-slim

# Install dependencies for jsdom and better-sqlite3
RUN apt-get update && apt-get install -y \
  python3 \
  python3-dev \
  python3-pip \
  build-essential \
  libcairo2-dev \
  libjpeg-dev \
  libpango1.0-dev \
  libgif-dev \
  libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

# Create recipes directory
RUN mkdir -p /recipes

# Expose port
EXPOSE 3000

# Run the application
CMD ["node", "server.js"]
