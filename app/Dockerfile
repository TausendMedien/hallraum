# Hallraum web app (for local development; on a server it can run directly with Node)
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
