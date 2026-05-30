# Drive Clone MVP (Fastify + Svelte + Tailwind + Cloudflare R2)

Website manajemen file mirip Google Drive dengan fitur:

- Register/login akun
- User pertama yang register otomatis menjadi `ADMIN`
- Create folder
- Upload file ke Cloudflare R2
- Copy file, cut/move file antar folder
- Delete file
- Public file sharing link
- Public folder sharing link (tanpa login)
- Permission folder share: `VIEW` (read-only) / `EDIT`
- Upload file/folder ke R2 dengan streaming multipart (lebih stabil untuk file besar)
- Ringkasan total storage user (GB + jumlah file)

## Stack

- Backend: Fastify + Prisma Client + MySQL
- Frontend: Svelte (Vite) + Tailwind CSS
- Object storage: Cloudflare R2 (S3-compatible API)

## Struktur Project

- `backend/` API server
- `frontend/` web UI
- `.env` konfigurasi global untuk backend + frontend
- `run.bat` jalankan backend + frontend sekaligus
- `run-backend.bat` jalankan backend saja
- `run-frontend.bat` jalankan frontend saja
- `docker-compose.yml` jalankan backend + frontend via Docker

## Setup

1. Copy environment file root:

```bash
copy .env.example .env
```

2. Isi nilai R2 di `/.env`:

- `DATABASE_URL` (MySQL connection string)
- `MYSQL_ROOT_PASSWORD`
- `MYSQL_DATABASE`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET` (nama bucket R2)
- `JWT_SECRET`
- `UPLOAD_MAX_FILE_SIZE_MB` (default `5120`)
- `UPLOAD_REQUEST_TIMEOUT_MS` (default `1800000`)
- `R2_MULTIPART_PART_SIZE_MB` (default `16`, minimal `5`)
- `R2_MULTIPART_QUEUE_SIZE` (default `4`)

3. Pastikan `VITE_API_BASE_URL` mengarah ke backend (default `http://localhost:4000`).

## Run

Jalankan keduanya:

```bash
run.bat
```

Atau terpisah:

```bash
run-backend.bat
run-frontend.bat
```

## Deploy di Coolify (Docker Compose)

```bash
docker compose up --build
```

Catatan penting:

- Compose ini memakai `expose` (bukan `ports`), jadi tidak bind host port langsung dan tidak bentrok dengan project/container lain.
- Compose ini sudah include service `mysql` internal.
- Di Coolify, publish service `frontend` pada port container `80`.
- Jika backend mau diakses publik (misal untuk API/public share), publish service `backend` pada port container `4000` dan beri domain terpisah, misalnya `api.domainkamu.com`.
- Untuk upload file besar, pastikan limit body pada reverse proxy/ingress Coolify juga dinaikkan (jika default terlalu kecil).
- Set env berikut di root `.env`:
  - `VITE_API_BASE_URL=https://api.domainkamu.com`
  - `FRONTEND_ORIGIN=https://app.domainkamu.com`
  - `PUBLIC_SHARE_BASE_URL=https://api.domainkamu.com`

Keterangan env penting:

- Endpoint R2 otomatis dipakai dari `R2_ACCOUNT_ID` dengan format `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.
- `PUBLIC_SHARE_BASE_URL` adalah base URL backend publik untuk membentuk link share file, contoh `https://api.domainkamu.com`.

## Endpoint Ringkas

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/folders?parentId=...`
- `POST /api/folders`
- `PATCH /api/folders/:id/move`
- `GET /api/files?folderId=...`
- `POST /api/files/upload` (multipart: `file`, optional `folderId`)
- `PATCH /api/files/:id/move`
- `POST /api/files/:id/copy`
- `POST /api/files/:id/share/public`
- `POST /api/folders/:id/share/public`
- `GET /api/files/storage/summary`
- `GET /api/files/:id/download-url`
- `DELETE /api/files/:id`
- `GET /api/public/:token`
- `GET /api/public/:token/download`
- `GET /api/public/folders/:token/content?folderId=...`
- `GET /api/public/folders/:token/files/:fileId/download`
- `POST /api/public/folders/:token/folders`
- `PATCH /api/public/folders/:token/folders/:folderId/rename`
- `DELETE /api/public/folders/:token/folders/:folderId`
- `POST /api/public/folders/:token/files/create`
- `POST /api/public/folders/:token/files/upload`
- `PATCH /api/public/folders/:token/files/:fileId/rename`
- `DELETE /api/public/folders/:token/files/:fileId`

Public folder link frontend:

- Format: `https://app.domainkamu.com?share=<folderPublicToken>`
