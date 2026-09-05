# Server nhac cho Xiaozhi tren Android

## 1. Cai Termux

Cai Termux tu F-Droid hoac GitHub chinh thuc. Khong dung ban Termux cu tren
Google Play vi co the khong con cap nhat goi Node.js.

## 2. Cai Node.js

Mo Termux va chay:

```bash
pkg update -y && pkg upgrade -y
pkg install nodejs-lts -y
node -v
```

## 3. Chep server vao dien thoai

Neu tai ca project ve dien thoai:

```bash
termux-setup-storage
cd ~/storage/downloads/xiaozhi-esp32-story-mp3-github-main/xiaozhi-esp32-story-mp3-github-main/server
```

Neu chi chep thu muc `server` vao bo nho dien thoai:

```bash
cd ~/storage/downloads/server
```

## 4. Them nhac

Tao hai thu muc sau va chep file MP3 vao do:

```bash
mkdir -p media/songs media/stories
```

- Nhac: `media/songs/`
- Truyen: `media/stories/`

Ten file nen dung chu cai, so, gach ngang; vi du `bai-hat-01.mp3`.

## 5. Chay server

```bash
node server.js
```

Termux se in ra dia chi, vi du:

```text
ESP32 base URL: http://192.168.1.25:3000/
```

Dien thoai va ESP32 phai ket noi cung mot Wi-Fi. Khong tat Termux hoac bat
che do tiet kiem pin khi dang phat nhac.

## 6. Ket noi firmware

Trong giao dien cau hinh/MCP, goi tool:

```text
self.story.set_base_url
url = http://192.168.1.25:3000/
```

Sau do goi:

```text
self.story.refresh_index
```

Kiem tra bang trinh duyet dien thoai:

```text
http://127.0.0.1:3000/health
http://127.0.0.1:3000/index.json
```

Server nay khong tai hoac vuot co che bao ve cua YouTube/Zing MP3. Chi su
dung file nhac ma ban co quyen su dung.
