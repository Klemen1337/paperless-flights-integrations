# Docker: build, push to Docker Hub, run on a server

Replace `YOUR_DOCKERHUB_USER` with your Docker Hub username everywhere below.
Commands are run from this folder unless noted.

## 1. Log in to Docker Hub

```sh
docker login -u YOUR_DOCKERHUB_USER
```

Use an access token as the password (Docker Hub → Account settings →
Personal access tokens), not your account password.

## 2. Build and push

### Option A: multi-arch (recommended)

Builds for both x86 servers (`amd64`) and ARM servers such as a Raspberry Pi
or an Ampere/Graviton VPS (`arm64`), and pushes in one step:

```sh
docker buildx create --name multi --use        # first time only
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t YOUR_DOCKERHUB_USER/paperless-paper-flights-integration:0.1.0 \
  -t YOUR_DOCKERHUB_USER/paperless-paper-flights-integration:latest \
  --push .
```

On Windows PowerShell, put the command on one line or replace `\` with a backtick.

### Option B: single architecture

Only if your server has the same CPU architecture as the machine you build on:

```sh
docker build -t YOUR_DOCKERHUB_USER/paperless-paper-flights-integration:0.1.0 .
docker tag YOUR_DOCKERHUB_USER/paperless-paper-flights-integration:0.1.0 YOUR_DOCKERHUB_USER/paperless-paper-flights-integration:latest
docker push YOUR_DOCKERHUB_USER/paperless-paper-flights-integration:0.1.0

docker build -t klemen1337/paperless-paper-flights-integration:latest .
docker push klemen1337/paperless-paper-flights-integration:latest
```

Bump the version tag (it matches `version` in `package.json` and `config.json`)
for each release, so you can roll back to an older tag on the server.

A new repository on Docker Hub is public by default. Make it private in the
repository settings if you prefer; the server then needs `docker login` too.

## 3. Run on the server

Create a folder on the server with this `docker-compose.yml`:

```yaml
services:
  flights-overhead:
    image: YOUR_DOCKERHUB_USER/paperless-paper-flights-integration:latest
    container_name: flights-overhead
    restart: unless-stopped
    ports:
      - "127.0.0.1:4400:4400"   # only reachable through the reverse proxy
```

```sh
docker compose pull
docker compose up -d
curl http://127.0.0.1:4400/health       # {"ok":true}
```

## 4. HTTPS

The paperlesspaper app needs a public HTTPS URL. Point a DNS name (for example
`flights.example.com`) at the server, then put a reverse proxy in front.

Caddy gets and renews the certificate automatically. `/etc/caddy/Caddyfile`:

```
flights.example.com {
    reverse_proxy 127.0.0.1:4400
}
```

nginx works too (`proxy_pass http://127.0.0.1:4400;` plus a certificate from
certbot). If the proxy itself runs in Docker, put both containers on one network
and proxy to `flights-overhead:4400` instead.

Check from any machine:

```sh
curl https://flights.example.com/config.json
curl "https://flights.example.com/api/data?photos=3"
```

## 5. Add it to paperlesspaper

In the paperlesspaper web app, add an Open Integration with the manifest URL:

```
https://flights.example.com/config.json
```

Then set your latitude, longitude and zoom in the integration settings.

## Updating

Build and push a new tag (step 2), then on the server:

```sh
docker compose pull
docker compose up -d
docker image prune -f
```
