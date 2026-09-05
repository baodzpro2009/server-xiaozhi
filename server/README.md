# Xiaozhi Music Server

Server Node.js thuần, chạy được trên Android bằng Termux và cung cấp file nhạc hợp pháp cho ESP32.

## Chạy trên Android

```bash
pkg update
pkg install nodejs-lts
cd server
node server.js
```

Chép file MP3 vào `server/media/songs/` hoặc `server/media/stories/`. ESP32 dùng base URL được in trong Termux, ví dụ:

```text
http://192.168.1.25:3000/
```

API:

- `GET /index.json`: danh sách file theo format firmware Xiaozhi
- `GET /api/search?q=ten-bai`: tìm kiếm
- `GET /songs/ten-bai.mp3`: phát/tải file, có hỗ trợ HTTP Range
- `GET /health`: kiểm tra server

Trong Xiaozhi gọi tool `self.story.set_base_url` với URL kết thúc bằng `/`, sau đó gọi `self.story.refresh_index`.

Server này không tải hoặc vượt cơ chế bảo vệ của YouTube/Zing MP3. Chỉ đưa lên các file bạn có quyền sử dụng.
