# EC2 Deploy

These steps assume Amazon Linux 2023 and the default `ec2-user`.

## 1. SSH in

```bash
ssh -i /path/to/key.pem ec2-user@EC2_PUBLIC_IP
```

## 2. Install Node.js and Caddy

```bash
sudo dnf update -y
sudo dnf install -y nodejs npm git
sudo dnf install -y 'dnf-command(copr)'
sudo dnf copr enable @caddy/caddy -y
sudo dnf install -y caddy
```

## 3. Copy the queue project

From your local machine:

```bash
rsync -av --exclude node_modules --exclude dist \
  /Users/delilah/Library/CloudStorage/Dropbox/Projects/2026/Hims/figma-hermes-copy-plugin/ \
  ec2-user@EC2_PUBLIC_IP:/opt/hermes-figma-queue/
```

On EC2:

```bash
cd /opt/hermes-figma-queue
npm install --omit=dev
```

## 4. Configure the queue token

Generate a token:

```bash
openssl rand -hex 32
```

Create env file:

```bash
sudo tee /etc/hermes-figma-queue.env >/dev/null <<'EOF'
HOST=127.0.0.1
PORT=8787
HERMES_QUEUE_DIR=/var/lib/hermes-figma-queue
HERMES_QUEUE_TOKEN=PASTE_TOKEN_HERE
EOF
```

Create queue storage:

```bash
sudo mkdir -p /var/lib/hermes-figma-queue
sudo chown -R ec2-user:ec2-user /var/lib/hermes-figma-queue
```

## 5. Install systemd service

```bash
sudo cp /opt/hermes-figma-queue/deploy/hermes-figma-queue.service /etc/systemd/system/hermes-figma-queue.service
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-figma-queue
sudo systemctl status hermes-figma-queue
```

## 6. Configure HTTPS

Point a DNS record at the EC2 public IP, for example:

```text
figma-queue.yourdomain.com -> EC2_PUBLIC_IP
```

Then on EC2:

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
figma-queue.yourdomain.com {
  reverse_proxy 127.0.0.1:8787
}
EOF

sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

## 7. Test

```bash
curl https://figma-queue.yourdomain.com/health

curl -X POST https://figma-queue.yourdomain.com/jobs \
  -H 'Authorization: Bearer PASTE_TOKEN_HERE' \
  -H 'Content-Type: application/json' \
  --data '{"jobId":"smoke","ads":[]}'
```

The `/health` endpoint is public. Job endpoints require the bearer token.

## 8. Figma plugin worker

In the plugin:

```text
Queue URL: https://figma-queue.yourdomain.com
Token: PASTE_TOKEN_HERE
Start listening
```
