FROM node:18-alpine

# 1. Set the working dir in the container
WORKDIR /usr/src/app

# 2. Copy package.json & install deps
COPY package*.json ./
RUN npm install

# 3. Copy everything else (your index.js, routes/, controllers/, etc)
COPY . .

# 4. Run your app (make sure package.json has "start": "node index.js")
CMD ["npm", "start"]
