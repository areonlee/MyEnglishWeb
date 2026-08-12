# Edge Function: `transcribe-audio`

系统 AI 一键生成字幕的**服务端代理**：校验登录 JWT → 扣除 10 积分 → 使用服务端 SiliconFlow Key 转写 → 返回结果。API Key 绝不下发到浏览器。

## 1. 配置 Secrets（必做）

在 **Supabase Dashboard**：

1. 打开 **Project Settings → Edge Functions → Secrets**（或 **Settings → Functions → Secrets**）
2. 新增密钥：
   - **Name**: `SILICONFLOW_API_KEY`
   - **Value**: 粘贴你的 SiliconFlow `sk-...` Key
3. 保存后重新部署本函数（Secrets 变更后建议 redeploy）

> `SUPABASE_URL` / `SUPABASE_ANON_KEY` 一般由平台自动注入，无需手动添加。

## 2. 执行数据库 RPC

在 SQL Editor 执行仓库中的 `supabase-schema.sql`（包含 `deduct_points_for_asr` / `refund_points_for_asr`），或单独执行其中「AI 字幕积分」一节。

## 3. 部署

```bash
npx supabase login
npx supabase link --project-ref <你的项目 ref>
npx supabase secrets set SILICONFLOW_API_KEY=sk-xxxxxxxx
npx supabase functions deploy transcribe-audio
```

## 4. 前端调用

系统模式下前端使用：

```js
const formData = new FormData();
formData.append('file', audioFile);

const { data, error } = await supabaseClient.functions.invoke('transcribe-audio', {
  body: formData,
});
```

成功时 `data.transcription` 为 SiliconFlow 原始 JSON；前端再走 `parseAndCombineSRT` 智能断句并入库。

## 注意事项

- 音频体积受 Edge Function 请求体限制影响，过大文件请压缩或改用 BYOK / 本地字幕导入。
- 默认模型：`FunAudioLLM/SenseVoiceSmall`；也可在 form 中传 `model` 字段覆盖。
