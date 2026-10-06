/**
 * Supabase Edge Function: transcribe-audio
 *
 * JWT 鉴权 → 扣除积分 → 按 provider 转发 ASR → 失败退还积分。
 *
 * Providers:
 *   sensevoice  SiliconFlow SenseVoiceSmall（系统默认，低成本）
 *   qwen_asr    阿里云百炼 qwen3-asr-flash-filetrans（精准时间戳，需 DASHSCOPE_API_KEY）
 *   whisper     OpenAI whisper-1 + verbose_json（海外版能力，代码保留）
 *
 * Secrets:
 *   SILICONFLOW_API_KEY   — provider=sensevoice
 *   DASHSCOPE_API_KEY     — provider=qwen_asr（阿里云百炼）
 *   OPENAI_API_KEY        — provider=whisper
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const ASR_POINTS_COST = 10;
const SILICONFLOW_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DASHSCOPE_UPLOADS = 'https://dashscope.aliyuncs.com/api/v1/uploads';
const DASHSCOPE_TRANSCRIBE = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const DASHSCOPE_TASKS = 'https://dashscope.aliyuncs.com/api/v1/tasks';

const SENSEVOICE_MODEL = 'FunAudioLLM/SenseVoiceSmall';
const QWEN_ASR_MODEL = 'qwen3-asr-flash-filetrans';
const WHISPER_MODEL = 'whisper-1';

type AsrProvider = 'sensevoice' | 'qwen_asr' | 'whisper';
type AsrSegment = { start: number; end: number; text: string };

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

function normalizeProvider(raw: string): AsrProvider {
  const p = String(raw || '').trim().toLowerCase();
  if (p === 'sensevoice' || p === 'siliconflow') return 'sensevoice';
  if (p === 'whisper' || p === 'openai') return 'whisper';
  if (p === 'qwen_asr' || p === 'qwen' || p === 'dashscope') return 'qwen_asr';
  // Default: SiliconFlow SenseVoice（已配置 SILICONFLOW_API_KEY）
  return 'sensevoice';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSegment(start: unknown, end: unknown, text: unknown): AsrSegment | null {
  const t = String(text || '').trim();
  const s = Number(start);
  const e = Number(end);
  if (!t || !Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  return { start: s, end: e, text: t };
}

function qwenTimesLookLikeMs(rows: AsrSegment[]): boolean {
  const times = rows.flatMap((r) => [r.start, r.end]).filter((n) => Number.isFinite(n));
  if (!times.length) return false;
  const max = Math.max(...times);
  const allInt = times.every((n) => n === Math.round(n));
  return allInt && max >= 1000;
}

function extractQwenSegments(payload: unknown): AsrSegment[] {
  const sentenceRows: Record<string, unknown>[] = [];
  const wordRows: Record<string, unknown>[] = [];

  const visit = (node: unknown, depth: number) => {
    if (!node || depth > 10) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.sentences)) {
      for (const s of obj.sentences) {
        if (s && typeof s === 'object') sentenceRows.push(s as Record<string, unknown>);
      }
    } else if (obj.sentences && typeof obj.sentences === 'object') {
      for (const s of Object.values(obj.sentences)) {
        if (s && typeof s === 'object') sentenceRows.push(s as Record<string, unknown>);
      }
    }
    if (Array.isArray(obj.words)) {
      for (const w of obj.words) {
        if (w && typeof w === 'object') wordRows.push(w as Record<string, unknown>);
      }
    }
    if (Array.isArray(obj.transcripts)) visit(obj.transcripts, depth + 1);
    if (obj.data) visit(obj.data, depth + 1);
    if (obj.result) visit(obj.result, depth + 1);
    if (obj.output) visit(obj.output, depth + 1);
    if (obj.file_transcription) visit(obj.file_transcription, depth + 1);
    if (Array.isArray(obj.results)) visit(obj.results, depth + 1);
  };

  visit(payload, 0);
  const rows = sentenceRows.length ? sentenceRows : wordRows;
  const raw: AsrSegment[] = [];
  for (const row of rows) {
    const seg = toSegment(
      row.begin_time ?? row.beginTime ?? row.start ?? row.startTime,
      row.end_time ?? row.endTime ?? row.end ?? row.endTime,
      row.text ?? row.en ?? row.content,
    );
    if (seg) raw.push(seg);
  }
  const asMs = qwenTimesLookLikeMs(raw);
  return raw.map((seg) => asMs
    ? { start: seg.start / 1000, end: seg.end / 1000, text: seg.text }
    : seg);
}

function pickTranscriptionUrl(taskOut: Record<string, unknown>): string {
  const asUrl = (v: unknown) => String(v || '').trim();
  const result = taskOut.result && typeof taskOut.result === 'object'
    ? taskOut.result as Record<string, unknown>
    : null;
  let url = asUrl(result?.transcription_url || result?.transcriptionUrl);
  if (url) return url;
  const results = Array.isArray(taskOut.results) ? taskOut.results : [];
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    url = asUrl((item as Record<string, unknown>).transcription_url);
    if (url) return url;
  }
  return asUrl(taskOut.transcription_url);
}

function upgradeTranscriptionUrl(url: string): string {
  if (url.startsWith('http://dashscope-result-') || url.startsWith('http://dashscope-result.')) {
    return 'https://' + url.slice('http://'.length);
  }
  return url;
}

function extractWhisperSegments(payload: unknown): AsrSegment[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const list = Array.isArray(root.segments) ? root.segments : [];
  const out: AsrSegment[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const seg = toSegment(row.start, row.end, row.text);
    if (seg && seg.end >= seg.start) out.push(seg);
  }
  return out;
}

function extractText(payload: unknown, segments: AsrSegment[]): string {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const direct = String(root.text || '').trim();
  if (direct) return direct;
  const transcripts = Array.isArray(root.transcripts) ? root.transcripts : [];
  const first = transcripts[0] && typeof transcripts[0] === 'object'
    ? transcripts[0] as Record<string, unknown>
    : null;
  const fromTranscript = String(first?.text || '').trim();
  if (fromTranscript) return fromTranscript;
  return segments.map((s) => s.text).join(' ').trim();
}

function sanitizeFilename(name: string): string {
  const base = String(name || 'audio.mp3').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return base.slice(0, 80) || 'audio.mp3';
}

async function uploadDashscopeOss(apiKey: string, model: string, file: Blob, filename: string): Promise<string> {
  const policyUrl = `${DASHSCOPE_UPLOADS}?action=getPolicy&model=${encodeURIComponent(model)}`;
  const policyRes = await fetch(policyUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  const policyRaw = await policyRes.text();
  if (!policyRes.ok) {
    throw new Error('DashScope 上传凭证失败：' + policyRaw.slice(0, 240));
  }
  let policyJson: Record<string, unknown>;
  try {
    policyJson = JSON.parse(policyRaw) as Record<string, unknown>;
  } catch {
    throw new Error('DashScope 上传凭证解析失败');
  }
  const data = (policyJson.data && typeof policyJson.data === 'object')
    ? policyJson.data as Record<string, string>
    : policyJson as Record<string, string>;
  const uploadDir = String(data.upload_dir || '');
  const uploadHost = String(data.upload_host || '');
  if (!uploadDir || !uploadHost) {
    throw new Error('DashScope 上传凭证缺少 upload_dir / upload_host');
  }
  const key = `${uploadDir}/${filename}`;
  const form = new FormData();
  form.append('OSSAccessKeyId', String(data.oss_access_key_id || ''));
  form.append('Signature', String(data.signature || ''));
  form.append('policy', String(data.policy || ''));
  form.append('x-oss-object-acl', String(data.x_oss_object_acl || 'private'));
  form.append('x-oss-forbid-overwrite', String(data.x_oss_forbid_overwrite || 'true'));
  form.append('key', key);
  form.append('success_action_status', '200');
  form.append('file', file, filename);

  const upRes = await fetch(uploadHost, { method: 'POST', body: form });
  if (!upRes.ok) {
    const upText = await upRes.text();
    throw new Error('DashScope OSS 上传失败：' + upText.slice(0, 240));
  }
  return `oss://${key}`;
}

async function transcribeQwenAsr(apiKey: string, file: Blob, filename: string): Promise<{ text: string; segments: AsrSegment[] }> {
  const ossUrl = await uploadDashscopeOss(apiKey, QWEN_ASR_MODEL, file, filename);

  const submitRes = await fetch(DASHSCOPE_TRANSCRIBE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
      'X-DashScope-OssResourceResolve': 'enable',
    },
    body: JSON.stringify({
      model: QWEN_ASR_MODEL,
      input: { file_url: ossUrl },
      parameters: {
        channel_id: [0],
        enable_itn: false,
        language: 'en',
        enable_words: false,
      },
    }),
  });
  const submitRaw = await submitRes.text();
  if (!submitRes.ok) {
    throw new Error('Qwen ASR 提交失败：' + submitRaw.slice(0, 240));
  }
  let submitJson: Record<string, unknown>;
  try {
    submitJson = JSON.parse(submitRaw) as Record<string, unknown>;
  } catch {
    throw new Error('Qwen ASR 提交结果无法解析');
  }
  const output = submitJson.output && typeof submitJson.output === 'object'
    ? submitJson.output as Record<string, unknown>
    : submitJson;
  const taskId = String(output.task_id || submitJson.task_id || '').trim();
  if (!taskId) {
    throw new Error('Qwen ASR 未返回 task_id');
  }

  let transcriptionUrl = '';
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const taskRes = await fetch(`${DASHSCOPE_TASKS}/${encodeURIComponent(taskId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    const taskRaw = await taskRes.text();
    if (!taskRes.ok) {
      throw new Error('Qwen ASR 查询失败：' + taskRaw.slice(0, 240));
    }
    let taskJson: Record<string, unknown>;
    try {
      taskJson = JSON.parse(taskRaw) as Record<string, unknown>;
    } catch {
      continue;
    }
    const taskOut = taskJson.output && typeof taskJson.output === 'object'
      ? taskJson.output as Record<string, unknown>
      : taskJson;
    const status = String(taskOut.task_status || '').toUpperCase();
    if (status === 'SUCCEEDED') {
      transcriptionUrl = upgradeTranscriptionUrl(pickTranscriptionUrl(taskOut));
      // Some payloads embed transcripts on the task itself
      if (!transcriptionUrl) {
        const inline = extractQwenSegments(taskJson);
        if (inline.length) {
          return { text: extractText(taskJson, inline), segments: inline };
        }
      }
      break;
    }
    if (status === 'FAILED' || status === 'UNKNOWN') {
      throw new Error('Qwen ASR 任务失败：' + String(taskOut.message || taskOut.code || status));
    }
  }
  if (!transcriptionUrl) {
    throw new Error('Qwen ASR 超时未完成，请稍后重试或缩短音频');
  }

  const resultRes = await fetch(transcriptionUrl);
  const resultRaw = await resultRes.text();
  if (!resultRes.ok) {
    throw new Error('Qwen ASR 结果下载失败：HTTP ' + resultRes.status);
  }
  const stripped = resultRaw.replace(/^\uFEFF/, '');
  let resultJson: unknown = stripped;
  try {
    resultJson = JSON.parse(stripped);
  } catch {
    throw new Error('Qwen ASR 结果不是 JSON');
  }
  const segments = extractQwenSegments(resultJson);
  const text = extractText(resultJson, segments);
  return { text, segments };
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
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const siliconflowKey = Deno.env.get('SILICONFLOW_API_KEY') ?? '';
  const dashscopeKey = Deno.env.get('DASHSCOPE_API_KEY') || Deno.env.get('QWEN_ASR_API_KEY') || '';
  const openaiKey = Deno.env.get('OPENAI_API_KEY') ?? '';

  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: 'Server misconfigured: missing Supabase env' }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing Authorization Bearer token' }, 401);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const supabaseAdmin = supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : null;

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user?.id) {
    return jsonResponse({ error: 'Unauthorized', detail: userError?.message }, 401);
  }

  if (!supabaseAdmin) {
    return jsonResponse({ error: 'Server misconfigured: missing service role key' }, 500);
  }

  const { data: membershipProfile, error: membershipError } = await supabaseAdmin
    .from('profiles')
    .select('vip_expire_date')
    .eq('id', user.id)
    .maybeSingle();

  const expireMs = membershipProfile?.vip_expire_date
    ? Date.parse(String(membershipProfile.vip_expire_date))
    : NaN;
  if (membershipError || !Number.isFinite(expireMs) || expireMs <= Date.now()) {
    return jsonResponse({
      error: '会员已过期',
      code: 'MEMBERSHIP_EXPIRED',
      message: '试用期已结束，请升级会员后继续使用。',
    }, 403);
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

  const provider = normalizeProvider(String(form.get('provider') || ''));
  const modelField = String(form.get('model') || '').trim();
  const model = provider === 'whisper'
    ? WHISPER_MODEL
    : provider === 'qwen_asr'
      ? QWEN_ASR_MODEL
      : (modelField || SENSEVOICE_MODEL);

  if (provider === 'whisper' && !openaiKey) {
    return jsonResponse({ error: 'Whisper provider not configured', hint: '请添加 OPENAI_API_KEY' }, 500);
  }
  if (provider === 'qwen_asr' && !dashscopeKey) {
    return jsonResponse({
      error: 'Qwen ASR provider not configured',
      hint: '在 Supabase Dashboard → Edge Functions → Secrets 添加 DASHSCOPE_API_KEY（阿里云百炼）',
    }, 500);
  }
  if (provider === 'sensevoice' && !siliconflowKey) {
    return jsonResponse({
      error: 'Server misconfigured: SILICONFLOW_API_KEY not set',
      hint: '在 Supabase Dashboard → Settings → Edge Functions → Secrets 中添加 SILICONFLOW_API_KEY',
    }, 500);
  }

  const { data: deductData, error: deductError } = await supabase.rpc('deduct_points_for_asr', {
    p_cost: ASR_POINTS_COST,
  });

  if (deductError) {
    const msg = deductError.message || '';
    if (/membership_expired/i.test(msg)) {
      return jsonResponse({
        error: '会员已过期',
        code: 'MEMBERSHIP_EXPIRED',
        message: '试用期已结束，请升级会员后继续使用。',
      }, 403);
    }
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
      if (!supabaseAdmin) throw new Error('missing service role key');
      await supabaseAdmin.rpc('refund_points_for_asr', {
        p_amount: ASR_POINTS_COST,
        p_reason: 'AI 字幕转写失败退还',
        p_user_id: user.id,
      });
    } catch (e) {
      console.error('refund_points_for_asr failed', e);
    }
  };

  const filename = sanitizeFilename(file instanceof File && file.name ? file.name : 'audio.mp3');

  try {
    let text = '';
    let segments: AsrSegment[] = [];

    if (provider === 'whisper') {
      const oaForm = new FormData();
      oaForm.append('file', file, filename);
      oaForm.append('model', WHISPER_MODEL);
      oaForm.append('response_format', 'verbose_json');
      oaForm.append('language', 'en');

      const oaRes = await fetch(OPENAI_TRANSCRIBE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiKey}` },
        body: oaForm,
      });
      const rawText = await oaRes.text();
      if (!oaRes.ok) {
        await refund();
        return jsonResponse({
          error: 'OpenAI Whisper 转写失败',
          status: oaRes.status,
          detail: rawText.slice(0, 500),
          refunded: true,
        }, 502);
      }
      let parsed: unknown = rawText;
      try { parsed = JSON.parse(rawText); } catch { parsed = { text: rawText }; }
      segments = extractWhisperSegments(parsed);
      text = extractText(parsed, segments);
    } else if (provider === 'qwen_asr') {
      const qwen = await transcribeQwenAsr(dashscopeKey, file, filename);
      text = qwen.text;
      segments = qwen.segments;
    } else {
      const sfForm = new FormData();
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
      let parsed: unknown = rawText;
      try { parsed = JSON.parse(rawText); } catch { parsed = { text: rawText }; }
      segments = extractWhisperSegments(parsed);
      text = extractText(parsed, segments);
    }

    const needsSegments = provider === 'qwen_asr' || provider === 'whisper';
    if (needsSegments && !segments.length) {
      await refund();
      return jsonResponse({
        error: '精准字幕服务未返回时间轴，请稍后重试',
        code: 'NO_TIMESTAMP_SEGMENTS',
        provider,
        refunded: true,
      }, 502);
    }

    console.log('[transcribe-audio]', {
      provider,
      model,
      textChars: text.length,
      segments: segments.length,
    });

    return jsonResponse({
      ok: true,
      user_id: user.id,
      deducted: ASR_POINTS_COST,
      points_remaining: Number.isFinite(pointsRemaining) ? pointsRemaining : null,
      provider,
      model,
      text,
      segments,
      transcription: { text, segments },
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
