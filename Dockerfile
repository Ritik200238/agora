# Agora — the self-running agent economy + live dashboard, in one container.
# It boots a local EVM, deploys the contracts, runs the economy, and serves the dashboard on $PORT.
FROM node:22-slim

WORKDIR /app

# install deps (incl. dev: hardhat + tsx are needed at runtime to run the local chain + server)
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# app source
COPY . .

# compile contracts at build time (downloads solc, writes artifacts)
RUN npx hardhat compile

ENV PORT=4000
ENV TICK_MS=1500
EXPOSE 4000

# The dashboard server self-spawns the local chain + deploys + runs the economy + serves the UI.
CMD ["npx", "tsx", "dashboard/server.ts"]
