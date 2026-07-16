# Windows Lock-Screen Tests

Độc lập, chạy được trên máy Win không cần agent chạy. Mục tiêu: xác định chính xác
giới hạn capture/input khi Windows lock, và con đường khả thi để vượt qua.

## Yêu cầu

```powershell
cd agent
npm install   # cài node-screenshots, @hurdlegroup/robotjs
```

PowerShell scripts: chạy với `powershell -ExecutionPolicy Bypass -File ...`.

## Thứ tự chạy

### Bước 1 — Xác nhận Capture bị đen khi lock (DXGI)

```powershell
node agent\tester\lockscreen\captureProbe.mjs 120 1000
```

Chạy 5s rồi `Win+L`. Quan sát log:
- `live` khi mở, `BLACK×N` hoặc `FROZEN×N` khi lock → xác nhận DXGI không thấy lock.
- Ghi `lockscreen-capture.log`.

### Bước 2 — So sánh với robotjs (BitBlt)

```powershell
node agent\tester\lockscreen\captureRobotjsProbe.mjs 120 1000
```

BitBlt cũng đen? Gần như chắc chắn yes. Nếu robotjs lại thấy được lock → lạ, đáng đào sâu.

### Bước 3 — Input có tới lock screen không?

```powershell
node agent\tester\lockscreen\sendInputProbe.mjs
```

Toggle Scroll Lock mỗi 4s. `Win+L`. Nếu LED Scroll Lock trên bàn phím vật lý vẫn nháy khi
lock → SendInput tới được Winlogon → blind unlock khả thi.

### Bước 4 — Blind unlock (cẩn thận)

```powershell
$env:LOCKPW="matkhau"; node agent\tester\lockscreen\blindUnlock.mjs 5
```

Đếm ngược 5s — `Win+L` ngay. Nếu máy tự mở khóa → SendInput đủ để unlock từ xa.

### Bước 5 — Desktop attach probe (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File agent\tester\lockscreen\probeDesktop.ps1
```

Chạy 2 lần: khi mở + khi lock (chạy qua SSH/scheduled task). So sánh `Input desktop`:
- Mở: `Default`. Lock: `Winlogon`.
- Đây là chứng cứ trực tiếp DXGI đen vì thread agent chạy trên `Default`, không phải `Winlogon`.

### Bước 6 — Thử attach Winlogon + capture

```powershell
powershell -ExecutionPolicy Bypass -File agent\tester\lockscreen\tryAttachWinlogon.ps1
```

Chạy khi đang lock. Xem kết quả:
- `desktop=Winlogon ... avgByte > 8` → **capture được lock screen** qua `SetThreadDesktop`. Đây là hướng RustDesk.
- `OpenInputDesktop FAILED` hoặc `SetThreadDesktop=FAIL` → phải chạy agent dưới `SYSTEM` (service) mới attach được. Đây là lý do TeamViewer/RustDesk chạy service.

### Bước 7 — Session state (thông tin thêm)

```powershell
powershell -ExecutionPolicy Bypass -File agent\tester\lockscreen\sessionState.ps1
```

`LogonUI.exe running` = đang lock. WTS state = `Active`/`Disconnected`.

## Ma trận quyết định

| Kết quả Bước 6 | Hướng triển khai |
|---|---|
| Capture Winlogon được (user quyền) | Agent gọi `SetThreadDesktop(OpenInputDesktop)` khi phát hiện lock. Code vừa phải. |
| Cần SYSTEM mới attach | Agent phải chạy như Windows service (SYSTEM). Lớn — cần installer + service lifecycle. |
| Cả hai fail | Loại hướng capture. Dùng blind unlock (Bước 4) làm feature phụ trợ. |

## Ghi chú bảo mật

- `blindUnlock.mjs` nhận password qua env/argv — cẩn thận history process. Xóa `LOCKPW` sau test.
- Không commit log file chứa thông tin session.
