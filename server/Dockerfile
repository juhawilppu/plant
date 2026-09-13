FROM node:22-alpine

WORKDIR /app

# Copied separately so a code change does not invalidate the dependency layer.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# All of the server's modules, not just index.js: mqtt-bridge.js is imported at
# startup, and seed-demo.js / fake-node.js are useful to run inside the
# container when debugging on the server.
COPY *.js ./

EXPOSE 8090
CMD ["node", "index.js"]
