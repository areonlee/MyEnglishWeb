# Edge Function: `transcribe-audio`

系统 AI 字幕代理：校验 JWT → 扣 10 积分 → 按 `provider` 转发 ASR → 统一返回 `{ text, segments }`。失败退还积分。

## Product defaults (DEC-011)

| 角色 | Provider | 说明 |
|---|---|---|
| **系统默认** | `sensevoice`（SiliconFlow SenseVoice） | 未传或无法识别 `provider` 时，函数回落为 `sensevoice` |
| **更高精度（BYOK）** | 阿里云百炼 / DashScope | 用户自带 Key 的更高精度选项（由前端 BYOK 路径调用；不是系统默认） |
| **可选兼容** | `whisper`（OpenAI） | 代码保留的可选路径；不得设为系统默认 |

## Providers（实现）

| provider | 用途 | 时间戳 |
|---|---|---|
| `sensevoice` | SiliconFlow `FunAudioLLM/SenseVoiceSmall`，**系统默认** | 通常无 segments，前端估算/断句 |
| `qwen_asr` | 阿里云百炼 `qwen3-asr-flash-filetrans`（需配置对应 Key） | **必须有** `segments` |
| `whisper` | OpenAI `whisper-1` + `verbose_json`（可选兼容） | **必须有** `segments` |

精准模式（`qwen_asr` / `whisper`）若无 segments，函数返回错误并退还积分。

## Secrets（名称）

在 **Supabase Dashboard → Edge Functions → Secrets**：

- `SILICONFLOW_API_KEY` — 系统默认 `sensevoice`（必配）
- `DASHSCOPE_API_KEY` — 仅当走服务端 `provider=qwen_asr` 时需要（非 DEC-011 产品默认）
- `OPENAI_API_KEY` — 仅当走服务端 `provider=whisper` 时需要

前端 BYOK（用户自填 Key）不依赖上述百炼/OpenAI Secrets。

## 部署

```bash
npx supabase functions deploy transcribe-audio
```

前端大陆/默认系统路径应传 `provider=sensevoice`（或不传，由函数回落）。不要把 `qwen_asr` 或 OpenAI 设为系统默认。

## 返回

```json
{
  "ok": true,
  "provider": "sensevoice",
  "text": "...",
  "segments": [],
  "transcription": { "text": "...", "segments": [] },
  "deducted": 10,
  "points_remaining": 90
}
```

`segments[].start` / `end` 单位为秒（当 provider 提供时间轴时）。
