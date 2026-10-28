#!/bin/bash
set -euo pipefail
# Rendered by deploy.py. This metadata contains resource references, never credentials.
PROJECT=__PROJECT__
HOST=__HOST__
BUCKET=__BUCKET__
OBJECT=__OBJECT__
SHA256=__SHA256__
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl python3 caddy
id saathi >/dev/null 2>&1 || useradd --system --home /var/lib/saathi --shell /usr/sbin/nologin saathi
DEVICE=/dev/disk/by-id/google-saathi-data
for i in $(seq 1 30); do test -b "$DEVICE" && break; sleep 2; done
test -b "$DEVICE"
mkdir -p /var/lib/saathi /opt/saathi/releases /etc/saathi /run/saathi
if ! blkid "$DEVICE" >/dev/null 2>&1; then mkfs.ext4 -F "$DEVICE"; fi
mountpoint -q /var/lib/saathi || mount "$DEVICE" /var/lib/saathi
UUID=$(blkid -s UUID -o value "$DEVICE")
grep -q ' /var/lib/saathi ' /etc/fstab || echo "UUID=$UUID /var/lib/saathi ext4 defaults,nofail 0 2" >> /etc/fstab
chown saathi:saathi /var/lib/saathi
chmod 700 /var/lib/saathi
chmod 700 /etc/saathi /run/saathi
cat > /usr/local/sbin/saathi-secrets.py <<'PY'
#!/usr/bin/python3
import base64,json,os,re,sys,urllib.request
def get(url,headers):
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=20) as r:
        return json.loads(r.read(1048576))
try:
    token=get('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{'Metadata-Flavor':'Google'})['access_token']
    project='__PROJECT__'
    values=[]
    for variable,secret in [('META_API_KEY','saathi-demo-meta-key'),('OPENROUTER_API_KEY','saathi-demo-openrouter-key')]:
        data=get(f'https://secretmanager.googleapis.com/v1/projects/{project}/secrets/{secret}/versions/latest:access',{'Authorization':'Bearer '+token})
        value=base64.b64decode(data['payload']['data'],validate=True).decode().strip()
        if not re.fullmatch(r'[A-Za-z0-9._~+/:=-]{10,4096}',value): raise ValueError('invalid secret shape')
        values.append(variable+'='+value)
    os.makedirs('/run/saathi',mode=0o700,exist_ok=True)
    fd=os.open('/run/saathi/keys.env.tmp',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f: f.write('\n'.join(values)+'\n')
    os.replace('/run/saathi/keys.env.tmp','/run/saathi/keys.env')
except Exception:
    print('Saathi secret bootstrap unavailable; service not started.',file=sys.stderr)
    sys.exit(1)
PY
chmod 700 /usr/local/sbin/saathi-secrets.py
TOKEN=$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')
curl -fsS --retry 2 -H "Authorization: Bearer $TOKEN" "https://storage.googleapis.com/$BUCKET/$OBJECT" -o /opt/saathi/release.tgz
unset TOKEN
echo "$SHA256  /opt/saathi/release.tgz" | sha256sum -c -
RELEASE=/opt/saathi/releases/$SHA256
mkdir -p "$RELEASE"
tar -xzf /opt/saathi/release.tgz -C "$RELEASE" --no-same-owner
tar -xzf "$RELEASE/linux-runtime.tgz" -C "$RELEASE" --strip-components=2 package/bin/bun
chmod 755 "$RELEASE/bun"
ln -sfn "$RELEASE" /opt/saathi/current
cat > /etc/saathi/runtime.env <<EOF
SAATHI_PUBLIC_ORIGIN=https://$HOST
SAATHI_DATABASE_PATH=/var/lib/saathi/state.sqlite
SAATHI_TENANT_PATH=/opt/saathi/current/examples/saathi
SAATHI_WEB_ROOT=/opt/saathi/current/saathi-web
SAATHI_DAILY_CALLS=20
SAATHI_WORKSPACE_DAILY_CALLS=5
SAATHI_ENABLE_META=true
SAATHI_META_MODELS=muse-spark-1.3
SAATHI_ALLOW_PAID_MODELS=false
BOT_MODEL=openrouter/free
COPILOTKIT_TELEMETRY_DISABLED=true
EOF
cat > /etc/systemd/system/saathi-secrets.service <<'EOF'
[Unit]
Description=Load resource-scoped Saathi provider keys into tmpfs
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/saathi-secrets.py
RemainAfterExit=yes
UMask=0077
EOF
cat > /etc/systemd/system/saathi.service <<'EOF'
[Unit]
Description=Saathi shared text demo
Requires=saathi-secrets.service
After=network-online.target saathi-secrets.service
RequiresMountsFor=/var/lib/saathi
ConditionPathIsMountPoint=/var/lib/saathi
[Service]
User=saathi
Group=saathi
WorkingDirectory=/opt/saathi/current
EnvironmentFile=/etc/saathi/runtime.env
EnvironmentFile=/run/saathi/keys.env
ExecStart=/opt/saathi/current/bun /opt/saathi/current/app.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/saathi
MemoryMax=400M
LimitNOFILE=4096
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/caddy/Caddyfile <<EOF
$HOST {
    encode gzip
    request_body {
        max_size 60KB
    }
    reverse_proxy 127.0.0.1:8790
}
EOF
systemctl daemon-reload
systemctl restart saathi-secrets
systemctl enable saathi
systemctl restart saathi
caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy
for i in $(seq 1 30); do if curl -fsS -H "Host: $HOST" http://127.0.0.1:8790/health >/dev/null; then echo "SAATHI_BACKEND_READY https://$HOST"; exit 0; fi; sleep 2; done
echo 'Saathi backend startup failed.' >&2
exit 1
