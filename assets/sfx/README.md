# 音效檔放這裡（可選）

遊戲所有音效預設用 Web Audio 程式合成（復古 8-bit 風）。
要把下面這四個換成真實音效（質感更好），把對應檔名的 mp3 放這個資料夾即可：

| 檔名 | 用途 | 建議來源（CC0 授權搜尋字） |
|---|---|---|
| `warn.mp3` | 海嘯警報聲（短促警報，0.5–1.5 秒）| siren / alarm / warning |
| `death.mp3` | 玩家被海嘯打死（嘩啦水花 + 重擊，0.8–1.5 秒）| splash / wave / impact |
| `deposit.mp3` | 存款入帳（一堆銅板嘩啦落下，1–2 秒）| coins fall / coin pile / cash register |
| `storm.mp3` | 暴風雨來臨（雷聲 / 低頻轟隆，1–2 秒）| thunder / storm / rumble |

## 推薦免費來源

- **[Pixabay Sound Effects](https://pixabay.com/sound-effects/)**：免費、可商用、不用註冊
- **[Mixkit](https://mixkit.co/free-sound-effects/)**：CC0 級授權
- **[Freesound](https://freesound.org/)**：要看單個檔案的 license，大多 CC0 / CC-BY

## 檔案要求

- 格式：MP3（.ogg 也行，但要改副檔名 + 改程式碼）
- 大小：每個 < 200 KB（短音效不需要更大）
- 取樣率：44.1 kHz / 96–128 kbps 夠用

## 沒放檔案會怎樣？

不會壞，只是這四個事件會用合成版本（一樣有聲音，只是電子味）。
其它所有音效（跳、撿錢、進坑等）原本就是合成，不需要檔案。
