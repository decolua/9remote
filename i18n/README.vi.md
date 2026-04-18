<div align="center">
  <img src="../images/9remote.png?1" alt="9Remote Dashboard" width="800"/>

  # 9Remote — Terminal Bỏ Túi

  **Muốn code ngay trên giường? Fix bug khi đang uống cà phê? Deploy lúc đang đi nghỉ?**

  **Terminal Mac/Linux/Windows, remote desktop và file explorer — truy cập từ điện thoại hoặc trình duyệt bất kỳ, mọi lúc mọi nơi.**

  [![npm version](https://img.shields.io/npm/v/9remote.svg)](https://www.npmjs.com/package/9remote)
  [![Downloads](https://img.shields.io/npm/dm/9remote.svg)](https://www.npmjs.com/package/9remote)
  [![License](https://img.shields.io/badge/license-Proprietary-orange.svg)](#-giấy-phép)

  [🚀 Bắt đầu nhanh](#-bắt-đầu-nhanh) • [📊 So sánh](#-9remote-vs-các-giải-pháp-remote-khác) • [💡 Tính năng](#-tính-năng-chính) • [🌐 Website](https://9remote.cc) • [📖 Tài liệu](https://docs.9remote.cc)

  [🇺🇸 English](../README.md) • [🇻🇳 Tiếng Việt](./README.vi.md)
</div>

---

## 🚧 Trạng Thái Phát Triển

> **9Remote hiện đang trong giai đoạn phát triển.**
>
> Mã nguồn **chưa được mở (open-source)**. Nếu dự án nhận được đủ ⭐ ủng hộ từ cộng đồng, chúng tôi sẽ **open-source toàn bộ** để mọi người có thể đóng góp và self-host.
>
> **⭐ Star repo này để giúp chúng tôi đạt cột mốc open-source!**

---

## 🤔 Tại Sao Chọn 9Remote?

**Remote access hiện tại rất phiền phức:**

- ❌ **SSH rườm rà** — mở firewall, cấu hình port forwarding, quản lý SSH key, IP whitelist
- ❌ **VPN quá phức tạp** — cài đặt dài dòng chỉ để check cái terminal
- ❌ **ngrok / tunnel hết hạn** — mất kết nối, phải khởi động lại tất cả
- ❌ **TeamViewer chậm** — độ trễ cao, chỉ desktop, tính phí thương mại
- ❌ **Chrome Remote Desktop** — không có terminal, không file explorer, không mobile
- ❌ **Termius** — chỉ SSH, không có remote desktop, không truy cập qua browser

**9Remote giải quyết tất cả:**

- ✅ **Một lệnh duy nhất** — cài đặt, quét QR, xong trong 30 giây
- ✅ **Tự động tunnel** — Cloudflare tunnel tự khởi động, không cần port forwarding
- ✅ **All-in-one** — terminal + remote desktop + file explorer + code editor trong một app
- ✅ **Chạy trên điện thoại** — workspace đầy đủ ngay trên browser, độ trễ dưới 50ms
- ✅ **Phiên làm việc bền** — PTY daemon sống sót qua các lần restart
- ✅ **Bảo mật Pair Device** — chỉ thiết bị được duyệt mới kết nối được, không cần đăng ký

---

## ⚡ Bắt Đầu Nhanh

**Cài đặt toàn cục:**

```bash
npm install -g 9remote
9remote
```

🎉 **Quét QR trên điện thoại → pair thiết bị → xong.**

**Vậy thôi!** Không cấu hình, không firewall, không đăng ký.

> **Sẵn sàng trong 30 giây.** Hỗ trợ macOS, Linux và Windows.

---

## 📊 9Remote vs Các Giải Pháp Remote Khác

| Tính năng | **9Remote** | Claude Remote | TeamViewer | Chrome Remote | Termius |
|-----------|:-----------:|:-------------:|:----------:|:-------------:|:-------:|
| Không cần cấu hình | ✅ | ✅ | ✅ | ✅ | ❌ |
| Terminal Access | ✅ | ✅ | ❌ | ❌ | ✅ |
| Remote Desktop | ✅ | ❌ | ✅ | ✅ | ❌ |
| File Explorer | ✅ | ❌ | ✅ | ❌ | ✅ |
| Code Editor | ✅ | ❌ | ❌ | ❌ | ❌ |
| Tích hợp Git | ✅ | ❌ | ❌ | ❌ | ❌ |
| Tối ưu cho Mobile | ✅ | ✅ | ❌ | ❌ | ✅ |
| Chạy trên Browser | ✅ | ✅ | ❌ | ✅ | ❌ |
| QR Login | ✅ | ✅ | ❌ | ❌ | ❌ |
| Auto Tunnel | ✅ | ✅ | ✅ | ✅ | ❌ |
| Phiên làm việc bền | ✅ | ✅ | ❌ | ❌ | ✅ |
| Đồng bộ nhiều thiết bị | ✅ | ✅ | ✅ | ❌ | ✅ |
| Push Notifications | ✅ | ✅ | ❌ | ❌ | ❌ |
| Tích hợp AI | ✅ | ✅ | ❌ | ❌ | ❌ |
| Không Port Forwarding | ✅ | ✅ | ✅ | ✅ | ❌ |
| Không cần tài khoản | ✅ | ❌ | ❌ | ❌ | ❌ |
| **TỔNG** | **16 / 16** | 11 / 16 | 7 / 16 | 5 / 16 | 7 / 16 |

> **🏆 9Remote: Giải pháp all-in-one đầy đủ 16/16 tính năng.**

---

## ✨ Tính Năng Chính

| Tính năng | Hoạt động như thế nào | Tại sao quan trọng |
|-----------|------------------------|---------------------|
| 🖥️ **Remote Terminal** | PTY shell đầy đủ qua WebSocket | Code như đang ngồi trước máy Mac |
| 🖱️ **Remote Desktop** | Live screen streaming qua WebRTC | Xem & điều khiển máy từ điện thoại |
| 📁 **File Explorer** | Duyệt, upload, download file | Quản lý file không cần SSH/SFTP |
| 💻 **Code Editor** | Editor tích hợp có syntax highlight | Sửa nhanh không cần mở IDE |
| 🔗 **Tích hợp Git** | Chạy lệnh git với trạng thái trực quan | Commit/push từ điện thoại |
| 📱 **Tối ưu Mobile** | UI cảm ứng, điều khiển cử chỉ | Workspace đầy đủ trên màn hình 6" |
| 🔑 **QR Login** | One-time key 30 phút, quét để kết nối | Kết nối mobile không ma sát |
| 🔒 **Auto Tunnel** | Cloudflare tunnel, không port forwarding | Hoạt động sau mọi NAT/firewall |
| 🔄 **Phiên làm việc bền** | PTY daemon sống sót qua restart | Lệnh chạy lâu không bị ngắt |
| 🌍 **Đồng bộ nhiều thiết bị** | Cùng phiên trên phone/tablet/laptop | Chuyển thiết bị không mất context |
| 🔔 **Push Notifications** | Build xong? Nhận thông báo ngay | Không bỏ lỡ sự kiện quan trọng |
| 🤖 **Tích hợp AI** | Hoạt động với Claude Code, Codex, OpenClaw | Code cùng AI ở mọi nơi |
| 🌐 **Local Sites Proxy** | Expose `localhost:3000` ra điện thoại | Test dev server trên mobile tức thì |
| ⚡ **Độ trễ thấp** | <50ms điển hình, WebRTC cho desktop | Cảm giác như local |
| 🔐 **Pair Device** | Duyệt từng thiết bị trước khi kết nối | Không truy cập trái phép, toàn quyền kiểm soát |
| 🆓 **Không cần tài khoản** | Machine ID + QR key, không đăng ký | Thiết kế ưu tiên quyền riêng tư |

---

## 📱 Các Nền Tảng Khả Dụng

<div align="center">
  <table>
    <tr>
      <td align="center" width="200">
        <b>💻 CLI</b><br/>
        <sub>npm install -g 9remote</sub><br/>
        <sub>macOS • Linux • Windows</sub>
      </td>
      <td align="center" width="200">
        <b>🖥️ Desktop App</b><br/>
        <sub>Tauri native app</sub><br/>
        <sub>macOS • Windows • Linux</sub>
      </td>
      <td align="center" width="200">
        <b>🌐 Web Client</b><br/>
        <sub><a href="https://9remote.cc">9remote.cc</a></sub><br/>
        <sub>Mọi browser hiện đại</sub>
      </td>
      <td align="center" width="200">
        <b>📱 Mobile App</b><br/>
        <sub>iOS • Android</sub><br/>
        <sub>React Native / Expo</sub>
      </td>
    </tr>
  </table>
</div>

---

## 🎯 Tình Huống Sử Dụng

### Case 1: "Code trên giường"

**Vấn đề:** 11h đêm, bạn chợt nhớ ra một bug nhưng laptop đang ở phòng khác.

**Giải pháp:**
```
1. Mở app 9remote trên điện thoại
2. Quét QR (hoặc dùng phiên đã lưu)
3. Mở terminal → fix bug → git push
4. Ngủ ngon 😴
```

### Case 2: "Fix bug tại quán cà phê"

**Vấn đề:** Production down. Bạn chỉ có điện thoại và Wi-Fi cafe yếu xìu.

**Giải pháp:**
```
1. Kết nối tới Mac ở nhà/văn phòng qua 9remote
2. Tail log trong terminal
3. Sửa config trong editor tích hợp
4. Deploy → khủng hoảng được dập tắt
```

### Case 3: "Deploy trong kỳ nghỉ"

**Vấn đề:** Khách hàng cần hotfix. Bạn đang ngoài bãi biển.

**Giải pháp:**
```
1. Điện thoại → 9remote → máy dev của bạn
2. git pull → build → deploy
3. Quay lại bãi biển trong 5 phút 🏖️
```

### Case 4: "Kỹ sư on-call"

**Vấn đề:** PagerDuty alert lúc 3h sáng. Không muốn dậy bật laptop.

**Giải pháp:**
```
1. Push notification → tap → 9remote mở ra
2. Terminal + remote desktop sẵn sàng
3. Chẩn đoán + restart service ngay từ giường
4. Xử lý sự cố mà không cần dậy
```

---

## 📖 Hướng Dẫn Cài Đặt

<details>
<summary><b>🚀 Các Cách Cài Đặt</b></summary>

### Cách 1 — NPM (khuyến nghị)

```bash
npm install -g 9remote
9remote
```

### Cách 2 — Desktop App

Tải từ [9remote.cc/download](https://9remote.cc) — app native có tích hợp system tray, tự khởi động cùng hệ điều hành, chạy nền.

### Cách 3 — Mobile App

- **iOS:** App Store → "9Remote"
- **Android:** Google Play → "9Remote"

</details>

<details>
<summary><b>🔑 Lần Chạy Đầu Tiên & QR Login</b></summary>

Lần chạy đầu tiên, 9Remote sinh hai loại key:

- **Permanent Key** — lưu cục bộ, gắn với machine ID, dùng cho thiết bị đã tin cậy
- **One-Time Key** — key tạm thời 30 phút, hiển thị dưới dạng QR trong terminal

**Kết nối từ điện thoại:**
1. Chạy `9remote` trên máy Mac/Linux/Windows
2. QR code sẽ hiển thị trong terminal
3. Mở app 9Remote (hoặc [9remote.cc](https://9remote.cc)) trên điện thoại
4. Quét QR → kết nối tức thì

> Key **không bao giờ** được lưu trên server của chúng tôi sau khi phiên kết thúc.

</details>

<details>
<summary><b>🖱️ Cài Đặt Remote Desktop (macOS)</b></summary>

Remote Desktop cần hai quyền hệ thống trên macOS:

1. **Screen Recording** — `System Settings → Privacy & Security → Screen Recording → bật Terminal (hoặc 9Remote Desktop app)`
2. **Accessibility** — `System Settings → Privacy & Security → Accessibility → bật Terminal (hoặc 9Remote Desktop app)`

Sau đó bật trong 9Remote:
```
TUI menu → Remote Desktop → Toggle ON
```

**Hiệu năng:**
- Framerate thích ứng: 60ms khi active / 400ms khi idle
- Render theo ô tile, chỉ gửi vùng thay đổi
- WebRTC DataChannel cho độ trễ tối thiểu

</details>

<details>
<summary><b>🌐 Local Sites Proxy</b></summary>

Expose local dev server (ví dụ `localhost:3000`, `localhost:5173`) ra điện thoại tự động.

```
9Remote tự phát hiện port đang chạy và proxy:
  http://localhost:3000  →  https://<tunnel>/proxy/3000/
  http://localhost:5173  →  https://<tunnel>/proxy/5173/
```

Hoàn hảo cho:
- Test responsive trên thiết bị thật
- Share bản WIP cho khách hàng
- Debug mobile không cần cáp USB

</details>

<details>
<summary><b>⌨️ Lệnh CLI</b></summary>

| Lệnh | Mô tả |
|------|-------|
| `9remote` | Chế độ TUI — menu tương tác có QR |
| `9remote ui` | Chế độ Web UI — mở dashboard browser tại `localhost:2208` |

</details>

---

## ❓ Câu Hỏi Thường Gặp

<details>
<summary><b>🔒 9Remote có an toàn không?</b></summary>

**Có.** 9Remote dùng hệ thống **Pair Device** — mọi thiết bị mới phải được bạn duyệt trước khi được quyền truy cập host. Ngoài ra:
- Không mở port nào trên máy (Cloudflare tunnel chỉ outbound)
- Key không bao giờ được lưu trên server sau khi phiên kết thúc
- Không thu thập terminal output, file hay dữ liệu màn hình
- One-time QR key hết hạn sau 30 phút
- Thiết bị pending/đã từ chối có thể quản lý bất kỳ lúc nào qua TUI menu

</details>

<details>
<summary><b>💰 Có miễn phí không?</b></summary>

**Có, trong giai đoạn phát triển.** 9Remote miễn phí hoàn toàn. Không đăng ký, không cần thẻ tín dụng.

Khi open-source, sẽ vẫn miễn phí mãi mãi (dự kiến giấy phép MIT).

</details>

<details>
<summary><b>📦 Khi nào sẽ open-source?</b></summary>

**Khi dự án đạt đủ ⭐ GitHub star** để chứng minh có cộng đồng quan tâm thực sự.

Chúng tôi muốn chắc chắn có cộng đồng ủng hộ trước khi cam kết duy trì open-source. Hãy star repo để giúp chúng tôi đạt cột mốc nhanh hơn!

</details>

<details>
<summary><b>🌐 Có cần mở port nào không?</b></summary>

**Không.** 9Remote dùng Cloudflare Quick Tunnel — chỉ kết nối outbound. Hoạt động sau:
- Router NAT ở nhà
- Firewall công ty
- Mobile hotspot
- VPN

</details>

<details>
<summary><b>📴 Có chạy offline / chỉ trong LAN được không?</b></summary>

**Được.** 9Remote có **LocalFirstAdapter** chạy song song LAN vs tunnel và dùng cái nào nhanh hơn. Nếu điện thoại và host cùng Wi-Fi, traffic đi trong mạng nội bộ.

</details>

<details>
<summary><b>🤖 Có dùng được AI coding tool qua 9Remote không?</b></summary>

**Được!** 9Remote hoạt động trơn tru với:
- Claude Code
- OpenAI Codex CLI
- Cursor
- OpenClaw
- Bất kỳ CLI tool nào chạy trong terminal

Chạy chúng trên máy host, truy cập từ điện thoại. Kết hợp với [9Router](https://github.com/decolua/9router), bạn có AI coding miễn phí ở mọi nơi.

</details>

<details>
<summary><b>🖥️ Hỗ trợ nền tảng nào?</b></summary>

**Host (nơi chạy 9Remote agent):**
- ✅ macOS (Intel + Apple Silicon)
- ✅ Linux (x64, arm64)
- ✅ Windows (x64)

**Client (nơi bạn kết nối từ đó):**
- ✅ Mọi browser hiện đại (Chrome, Safari, Firefox, Edge)
- ✅ iOS 14+
- ✅ Android 8+
- ✅ Tauri desktop app (macOS, Windows, Linux)

</details>

---

## 🛠️ Công Nghệ Sử Dụng

- **Runtime:** Node.js 20+
- **Tunnel:** [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — tunnel bảo mật không cấu hình
- **Terminal:** [node-pty](https://github.com/microsoft/node-pty) — phiên PTY bền bỉ
- **Remote Desktop:** [node-datachannel](https://github.com/murat-dogan/node-datachannel) (WebRTC) + [robotjs](https://github.com/octalmage/robotjs) (điều khiển input)
- **Real-time:** [Socket.IO](https://socket.io/) — streaming terminal + signaling WebRTC
- **Agent UI:** [Preact](https://preactjs.com/) — dashboard nhúng nhẹ
- **Web Client:** [Next.js 16](https://nextjs.org/) + React 19 + Tailwind CSS 4
- **Desktop App:** [Tauri 2](https://tauri.app/) — shell native có auto-updater
- **Mobile App:** [Expo](https://expo.dev/) — React Native với WebView shell
- **Edge API:** Cloudflare Workers — quản lý phiên + TURN credentials

---

## 🐛 Xử Lý Sự Cố

**"Port 2208 already in use"**
- Một instance 9Remote khác đang chạy → `pkill -f 9remote` rồi thử lại
- Hoặc chạy port khác: `PORT=3308 9remote`

**"Cloudflare tunnel failed to start"**
- Kiểm tra kết nối internet
- `cloudflared` tự cài ở lần chạy đầu — nếu lỗi, cài thủ công: [tài liệu cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

**"Screen Recording / Accessibility permission denied" (macOS)**
- Cấp quyền trong `System Settings → Privacy & Security`
- Khởi động lại 9Remote sau khi cấp

**"QR code expired"**
- One-time key hết hạn sau 30 phút → tạo lại từ TUI menu: `Key → Regenerate`

**"Can't connect from phone"**
- Kiểm tra cả hai thiết bị có internet
- Thử ép dùng tunnel mode (bỏ qua LAN): Settings → Connection → Tunnel only

**"Remote desktop bị lag"**
- Giảm độ phân giải trong cài đặt
- Chuyển sang chỉ terminal nếu không cần desktop
- Dùng LAN mode nếu cùng Wi-Fi để có độ trễ thấp nhất

---

## ⭐ Ủng Hộ Chúng Tôi

**9Remote đang trong giai đoạn phát triển và cần sự ủng hộ của bạn để đạt cột mốc open-source!**

- ⭐ **Star repo này** — mỗi sao đưa chúng tôi gần hơn đến việc open-source
- 🐦 **Chia sẻ trên Twitter / X** — giới thiệu 9Remote cho dev khác
- 🐛 **Báo lỗi** — phát hiện bug? Hãy cho chúng tôi biết!
- 💡 **Đề xuất tính năng** — điều gì sẽ giúp workflow remote của bạn tốt hơn?

---

## 📧 Hỗ Trợ & Liên Kết

- **Website:** [9remote.cc](https://9remote.cc)
- **Tài liệu:** [docs.9remote.cc](https://docs.9remote.cc)
- **NPM Package:** [npmjs.com/package/9remote](https://www.npmjs.com/package/9remote)
- **GitHub:** [github.com/decolua/9remote](https://github.com/decolua/9remote)
- **Issues:** [github.com/decolua/9remote/issues](https://github.com/decolua/9remote/issues)

---

## 📄 Giấy Phép

**Proprietary — All Rights Reserved.**

9Remote hiện đang trong giai đoạn phát triển và **chưa open-source**. Gói npm đã publish được dùng miễn phí, nhưng mã nguồn chưa công khai.

> **🎯 Cột mốc open-source:** khi repo đạt đủ ⭐ ủng hộ, toàn bộ mã nguồn sẽ được phát hành theo giấy phép **MIT**.

---

<div align="center">
  <sub>Làm bằng ❤️ cho các dev code ở mọi nơi — trên giường, ngoài biển, hay trên xe bus.</sub>
</div>
