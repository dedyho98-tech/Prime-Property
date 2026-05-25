# Panduan Singkat Superadmin Prime Property

## Login

1. Buka `http://localhost:3000/agent/login`.
2. Masuk dengan akun superadmin.
3. Gunakan menu profil di kanan atas untuk logout.

## Mengelola Properti

- Klik `+ Tambah Properti` untuk membuat listing baru.
- Isi semua field wajib: nama, ukuran, hadap, tipe, tingkat, harga, carport, status, kesiapan, dan kawasan.
- Gunakan `Simpan & Tambah Lagi` untuk input berurutan.
- Klik baris tabel untuk membuka detail properti.
- Tombol `Edit` dan `Hapus` tersedia di drawer detail untuk superadmin.
- Hapus properti bersifat soft delete, sehingga data diberi `deleted_at` dan hilang dari listing default.

## Filter dan Pencarian

- Gunakan search bar untuk nama properti, group, atau kawasan.
- Filter tersedia untuk kawasan, lebar minimum, hadap, harga maksimum, tipe, status, kesiapan, dan carport.
- Chip filter aktif dapat diklik untuk menghapus satu filter.
- URL menyimpan filter sehingga bisa dibagikan.

## Mengelola Admin

- Buka tab `Admin`.
- Buat akun admin baru melalui form.
- Gunakan tombol aktif/nonaktif untuk disable atau enable akun.
- Gunakan `Reset Password` untuk membuat password sementara.

## Audit Log

Tab `Audit Log` menampilkan perubahan properti dan akun admin: siapa, kapan, aksi, dan ringkasan perubahan.
