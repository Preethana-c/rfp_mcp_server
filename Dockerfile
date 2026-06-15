FROM node:22-slim

# pandoc converts the generated markdown proposal into a branded .docx
RUN apt-get update && apt-get install -y pandoc && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

# These directories hold files uploaded via /upload/sample and /upload/template.
# For persistence across Railway redeploys, mount a Railway volume at /app/samples
# and /app/templates. Without a volume, files survive restarts but are wiped on redeploy.
RUN mkdir -p samples templates

EXPOSE 3000

CMD ["node", "index.js"]
