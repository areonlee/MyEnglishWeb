/**
 * Supabase Edge Function: transcribe-audio
 *
 * 生产级代理：JWT 鉴权 → 校验/扣除积分 → 使用服务端 SILICONFLOW_API_KEY 转发转写。
 *
 * 部署前请在 Supabase Dashboard 配置 Secrets：
 *   Settings → Edge Functions → Secrets
 *   添加：SILICONFLOW_API_KEY = 你的 SiliconFlow sk- Key
 *
 * 部署命令示例：
 *   npx supabase functions deploy transcribe-audio
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const ASR_POINTS_COST = 10;
const SILICONFLOW_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions';
const DEFAULT_MODEL = 'FunAudioLLM/SenseVoiceSmall';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const siliconflowKey = Deno.env.get('SILICONFLOW_API_KEY') ?? '';

  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: 'Server misconfigured: missing Supabase env' }, 500);
  }

  if (!siliconflowKey) {
    return jsonResponse({
      error: 'Server misconfigured: SILICONFLOW_API_KEY not set',
      hint: '在 Supabase Dashboard → Settings → Edge Functions → Secrets 中添加 SILICONFLOW_API_KEY',
    }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing Authorization Bearer token' }, 401);
  }

  // 使用用户 JWT 创建客户端，保证 auth.uid() 可用于 RPC
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user?.id) {
    return jsonResponse({ error: 'Unauthorized', detail: userError?.message }, 401);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: 'Expected multipart/form-data with audio file' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File) && !(file instanceof Blob)) {
    return jsonResponse({ error: 'Missing audio file field: file' }, 400);
  }

  const modelField = String(form.get('model') || '').trim();
  const model = modelField || DEFAULT_MODEL;

  // 1) 原子扣积分（不足则失败，不调用第三方）
  const { data: deductData, error: deductError } = await supabase.rpc('deduct_points_for_asr', {
    p_cost: ASR_POINTS_COST,
  });

  if (deductError) {
    const msg = deductError.message || '';
    if (/insufficient_points|积分不足/i.test(msg)) {
      return jsonResponse({
        error: '积分不足',
        code: 'INSUFFICIENT_POINTS',
        need: ASR_POINTS_COST,
        message: '积分不足，请前往【会员福利】获取积分或切换为自带 Key 模式',
      }, 403);
    }
    return jsonResponse({
      error: '积分扣除失败',
      detail: msg,
      hint: '请确认已在 SQL Editor 执行 deduct_points_for_asr 函数',
    }, 400);
  }

  const pointsRemaining = Number((deductData as { points?: number } | null)?.points);
  let refunded = false;

  const refund = async () => {
    if (refunded) return;
    refunded = true;
    try {
      await supabase.rpc('refund_points_for_asr', {
        p_amount: ASR_POINTS_COST,
        p_reason: 'AI 字幕转写失败退还',
      });
    } catch (e) {
      console.error('refund_points_for_asr failed', e);
    }
  };

  // 2) 服务端 Key 转发 SiliconFlow
  try {
    const sfForm = new FormData();
    const filename = file instanceof File && file.name ? file.name : 'audio.mp3';
    sfForm.append('file', file, filename);
    sfForm.append('model', model);

    const sfRes = await fetch(SILICONFLOW_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${siliconflowKey}` },
      body: sfForm,
    });

    const rawText = await sfRes.text();
    if (!sfRes.ok) {
      await refund();
      return jsonResponse({
        error: 'SiliconFlow 转写失败',
        status: sfRes.status,
        detail: rawText.slice(0, 500),
        refunded: true,
      }, 502);
    }

    let transcription: unknown = rawText;
    try {
      transcription = JSON.parse(rawText);
    } catch {
      // 若返回纯文本/SRT，原样放入 text 字段
      transcription = { text: rawText };
    }

    return jsonResponse({
      ok: true,
      user_id: user.id,
      deducted: ASR_POINTS_COST,
      points_remaining: Number.isFinite(pointsRemaining) ? pointsRemaining : null,
      model,
      // SiliconFlow 原始结果（通常为 { text: "..." }）
      transcription,
    });
  } catch (e) {
    await refund();
    return jsonResponse({
      error: '转写代理异常',
      detail: e instanceof Error ? e.message : String(e),
      refunded: true,
    }, 500);
  }
});
