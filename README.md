# Prime Property

Web platform publik dan portal agent internal sesuai dokumen acceptance criteria `Prime_Property_Acceptance_Criteria.pdf`.

## Menjalankan

```bash
npm install
npm start
```

Aplikasi berjalan di `http://localhost:3000`.

Jika `bcryptjs` belum terpasang, aplikasi tetap bisa berjalan dengan fallback `scrypt` bawaan Node.js. Setelah `npm install`, hash password baru akan memakai bcrypt cost 10 sesuai kriteria.

## Akun Awal

- Superadmin: `superadmin@primeproperty.local` / `PrimeSuper123!`
- Admin: `admin@primeproperty.local` / `PrimeAdmin123!`

## Cakupan

- Landing page, About Us, dan Contact Us berbahasa Indonesia dengan palette Prime Property.
- Contact form dengan validasi, CSRF, rate limit 3 submit/IP/jam, dan antrean notifikasi admin di `data/contact_outbox.json`.
- Login agent `/agent/login` dengan session httpOnly cookie `SameSite=Lax` selama 30 hari.
- Lockout akun 15 menit setelah 5 gagal login dalam 30 menit.
- Dashboard internal dengan role admin dan superadmin.
- Backend authorization untuk semua endpoint mutasi; admin menerima `403 Forbidden`.
- Listing properti dengan 60 data dummy, tabel kompak, drawer detail, filter real-time, chip filter, pagination, sorting, dan URL query params.
- CRUD properti hanya untuk superadmin, validasi client/server, soft delete, audit log.
- Manajemen akun admin dan reset password oleh superadmin.

## Catatan Produksi

- Set `NODE_ENV=production` agar cookie memakai flag `Secure`.
- Set `ADMIN_EMAIL` untuk tujuan notifikasi kontak. Implementasi lokal menyimpan antrean email di `data/contact_outbox.json` agar tetap bisa diverifikasi tanpa SMTP.
