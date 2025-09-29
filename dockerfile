# Dockerfile
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /usr/src/app

# Install only prod deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app
COPY . .

# (Optional) tiny healthcheck tool is available via busybox wget
EXPOSE 8080
CMD ["npm", "start"]
