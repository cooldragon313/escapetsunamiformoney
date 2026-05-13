# 帳號系統實作交接（2026-05-13）

## 目前狀態

**程式碼寫完了，但沒部署、沒實測**。下次接手時請從「上線前必做」往下走。

## 已完成

### 伺服器（[party/server.js](party/server.js)）
- HTTP `onRequest` 處理 `POST /register`、`POST /login`、`GET /me`
- PBKDF2-SHA256 密碼雜湊（12 萬輪、16 byte salt），HMAC-SHA256 簽 token，90 天有效
- WebSocket 連線改成「先送 `auth_required` → 等 client 回 `auth` 訊息 → 驗 token → 才送 `init`」，15 秒沒 auth 直接踢
- 排行榜改用 `userId` 為 key（舊資料偵測到舊格式直接清空）
- 地塊（plots）擁有人改 `userId`，並持久化到 DO storage（重啟不會消失）
- Profile 存在 DO storage 的 `user:<lowercase username>` key 下，欄位：`{ username, displayName, hash, salt, profile: { custom, progress }, createdAt }`
- 訊息類型新增：`auth`、`auth_required`、`auth_failed`、`auth_timeout`、`profile_save`

### 用戶端（[index.html](index.html)）
- 新 `auth-screen` overlay（登入/註冊 tab、帳號/顯示名稱/密碼欄位）
- 新 `migrate-screen` overlay（首次登入提示「要不要把舊 localStorage 角色搬上雲」）
- Title 畫面按鈕變成「登入 / 註冊 →」（沒 token）或「開始冒險 →」（有 token）
- localStorage 改成：`etfm-token`、`etfm-username`、`etfm-display`、`etfm-cache-<user>`（快取）
- WS 連線 open → 收 `auth_required` → 送 `auth` token → 收 `init` → 套用 profile
- `saveProgress()` 從寫 localStorage 改成發 `profile_save` 訊息（離線時排隊、連上後 flush）
- 排行榜 `me` highlight 改用 `userId` 比對
- 地塊 `isMine` 判斷全改 `userId`
- 修了一個 race：登出再登入時舊 socket 的 close handler 會 null 掉新 socket
- 註冊成功 → 直接到 creator-screen 強迫客製化；登入成功 → 回 title-screen

### 文件
- [README.md](README.md)：移除「多角色 Profile」章節、加「帳號系統（跨裝置）」、deploy 步驟加 `AUTH_SECRET`
- [.gitignore](.gitignore)：加 `.env` / `.env.local`

## 上線前必做（順序很重要）

### 1. 設 AUTH_SECRET（**絕對不能跳過**）
```bash
# 生一個夠長的隨機字串，輸入到 partykit env
npx partykit env add AUTH_SECRET
# 互動式貼入，或：
openssl rand -hex 32 | npx partykit env add AUTH_SECRET
```
沒設這個 → server 會用 fallback 的 `dev-insecure-secret-please-replace` → **任何人都能偽造 token 登入別人的帳號**。

### 2. 本機跑一次端到端測試
```bash
# 本機需要先設個 .env（已加進 .gitignore）
echo 'AUTH_SECRET=local-dev-secret-just-for-testing' > .env
npm run dev
```
把 [index.html](index.html#L555) 的 `PARTYKIT_HOST` 暫時改 `localhost:1999`，瀏覽器開 `index.html`，至少跑這 5 個流程：

1. **首次註冊**：清 localStorage → 開遊戲 → 註冊新帳號 → 跑到 creator → 進遊戲 → 撿幾顆金幣 → 回廣場存款 → 重整 → 確認餘額還在
2. **登入**：上面註冊完後登出 → 用同帳密登入 → 確認金額、外觀都對
3. **跨裝置**：開無痕視窗、登入同帳號 → 兩邊應該看到一樣的存款
4. **冒名擋下**：兩個瀏覽器分別註冊兩個帳號，A 取顯示名稱 "test"，B 也想用 "test" → 註冊時 displayName 沒擋（**目前 displayName 沒去重，只擋 username**），但兩人的 userId 不同所以排行榜分開 → 這算 feature 還是 bug 自己判斷
5. **遷移**：在 localStorage 手動塞一筆 `etfm-profile-勇者` 資料 → 註冊新帳號 → 看到「偵測到本機進度」視窗 → 選擇匯入 → 進遊戲確認餘額帶過來

### 3. 部署後改回 prod host
```js
// index.html line ~555
const PARTYKIT_HOST = 'etfm.cooldragon313.partykit.dev';
```

```bash
npm run deploy
git push
```

## 已知的小問題 / 後續可做

| 項目 | 影響 | 嚴重度 |
|---|---|---|
| `displayName` 沒去重，可能多人同名 | 排行榜不會混（用 userId 比對），但聊天/玩家清單會看到同名 | 低 |
| 沒忘記密碼流程 | 玩家忘了密碼只能重註冊 | 中（看玩家黏度） |
| 舊房屋地塊資料全清掉了 | 之前用 conn.id 當 owner，重啟就會掉，所以本來也沒人擁有什麼 | 低 |
| Token 過期沒 refresh 機制 | 90 天後要重新登入 | 低 |
| 同帳號多裝置同時登入 → 兩邊 profile_save 互相蓋 | 後寫的贏 | 低（多裝置不會同時玩） |
| 沒 rate limit 在 register/login | 暴力破解理論可能 | 中（PBKDF2 12 萬輪已經夠慢） |
| 線上玩家清單 (其他玩家) 還用 conn.id 為 key | 同一個帳號多開分頁會出現兩個自己 | 低 |

## 重要檔案位置

- 認證邏輯：[party/server.js:55-156](party/server.js#L55-L156)（helpers）+ [171-258](party/server.js#L171-L258)（onRequest）
- Auth screen UI：[index.html:357-417](index.html#L357-L417)
- Auth state + API：[index.html:2895-2950](index.html#L2895-L2950)
- WS auth handshake：`mpHandleMessage` 開頭的 `auth_required` / `auth_failed` 分支
- 重置 token 用：清掉 `localStorage.etfm-token` 然後重整就會回到登入畫面

## 對玩家公告（建議）

部署後可以在 Discord / 任何溝通管道貼：

> 帳號系統上線了！
>
> - 第一次玩請註冊（帳號 3-16 個英數字底線、顯示名稱 1-16 字、密碼至少 6 字）
> - 同一個帳號可以在電腦、手機、平板各裝置玩
> - 排行榜紀錄也跟著帳號走，不會被別人冒名
> - **舊排行榜全部歸零**
> - 之前在本機有存檔的，註冊時可以選擇搬上雲端
> - 沒有忘記密碼功能，請用記得住的
