# Ovagames Mirror - Full Reverse Proxy

Mirror reverse proxy untuk **ovagames.com** yang bisa di-deploy ke Railway, Render, VPS, atau Docker.

## Arsitektur

Menggunakan **rebrowser-playwright-core** + **chrome-launcher** (pendekatan botasaurus) untuk bypass Cloudflare protection:

1. **Xvfb virtual display** - Chrome berjalan tanpa `--headless` agar tidak terdeteksi CF
2. **Fresh browser per page** - Setiap halaman baru di-load via Chrome baru (first-load selalu lolos CF)
3. **CDP asset capture** - CSS/JS/images di-capture via Chrome DevTools Protocol saat page load
4. **30-menit cache** - Semua konten di-cache agar request berulang instan (~0.01s)
5. **HTML rewriting** - Semua URL, canonical, structured data, meta tags di-rewrite ke domain mirror

## Fitur SEO

| Masalah GSC | Solusi |
|---|---|
| **Duplikat, Google memilih versi kanonis yang berbeda** | Canonical URL di-rewrite ke domain mirror, hanya 1 canonical per halaman |
| **Tidak ditemukan (404)** | Upstream error dikembalikan sebagai 502 (bukan 404), redirect di-handle manual |
| **Halaman dengan pengalihan** | Redirect Location header di-rewrite ke domain mirror, chain redirect dihindari |
| **Data terstruktur Breadcrumb** | JSON-LD BreadcrumbList diperbaiki: format, position, @type, URL semuanya di-fix |
| **Data terstruktur tidak dapat diurai** | JSON-LD yang invalid di-parse & diperbaiki, jika gagal dihapus agar tidak mengganggu |

## Fitur Lainnya

- Full URL rewriting: HTML href/src, CSS url(), JS strings, JSON, XML/Sitemap, RSS/Atom
- Meta tags rewriting: og:url, twitter:url, og:image
- Inline script & style rewriting
- robots.txt otomatis dengan sitemap
- Kompresi gzip/brotli
- Cache headers optimal per content type
- Health check endpoint (`/_health`)

## Environment Variables

| Variable | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port server |
| `SOURCE_DOMAIN` | `www.ovagames.com` | Domain sumber yang di-mirror |
| `MIRROR_DOMAIN` | `localhost` | Domain mirror kamu |
| `SOURCE_PROTOCOL` | `https` | Protocol sumber |
| `MIRROR_PROTOCOL` | `https` | Protocol mirror |
| `CHROME_PATH` | auto-detect | Path ke Google Chrome binary |

## Deploy

### Railway

1. Push repo ke GitHub
2. Connect repo di [Railway](https://railway.app)
3. Set environment variables:
   ```
   MIRROR_DOMAIN=yourdomain.com
   MIRROR_PROTOCOL=https
   SOURCE_DOMAIN=www.ovagames.com
   ```
4. Deploy otomatis dari `railway.toml`

### Render

1. Push repo ke GitHub
2. Connect repo di [Render](https://render.com)
3. Blueprint otomatis dari `render.yaml`
4. Set `MIRROR_DOMAIN` di environment variables

### VPS / Docker

```bash
# Install Chrome & Xvfb (Ubuntu/Debian)
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb || sudo apt-get install -f -y
sudo apt-get install -y xvfb

# Clone repo
git clone <your-repo-url>
cd Ovagames

# Install dependencies
npm install

# Set environment variables
export MIRROR_DOMAIN=yourdomain.com
export MIRROR_PROTOCOL=https

# Run
node server.js
```

### Docker

```bash
docker build -t ovagames-mirror .
docker run -d -p 3000:3000 \
  -e MIRROR_DOMAIN=yourdomain.com \
  -e MIRROR_PROTOCOL=https \
  ovagames-mirror
```

### VPS dengan Nginx (recommended)

Jalankan Node.js app, lalu reverse proxy dengan Nginx:

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering on;
        proxy_buffer_size 128k;
        proxy_buffers 4 256k;
    }
}
```

## Systemd Service (VPS)

```ini
[Unit]
Description=Ovagames Mirror Proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/ovagames-mirror
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=NODE_ENV=production
Environment=MIRROR_DOMAIN=yourdomain.com
Environment=MIRROR_PROTOCOL=https

[Install]
WantedBy=multi-user.target
```

## Tips SEO

1. **Set MIRROR_DOMAIN** ke domain kamu yang sebenarnya (bukan localhost)
2. **Submit sitemap** di Google Search Console: `https://yourdomain.com/sitemap.xml`
3. **Tunggu** Google re-crawl setelah canonical URL ter-fix
4. **Request indexing** ulang di GSC untuk halaman-halaman penting