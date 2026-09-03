/**
 * Edge Function: lookup-word
 *
 * JWT 鉴权 → 调用百度翻译通用文本 API → 返回中文释义。
 * Secrets: BAIDU_FANYI_APP_ID, BAIDU_FANYI_SECRET
 *
 * 百度控制台不要限制 IP 白名单（Edge Function 出口 IP 会变）。
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import md5 from 'https://esm.sh/blueimp-md5@2.19.0';

const BAIDU_URL = 'https://fanyi-api.baidu.com/api/trans/vip/translate';

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

function mapBaiduError(code: string): string {
  const table: Record<string, string> = {
    '52001': '词典服务超时，请稍后再试',
    '52002': '词典服务异常，请稍后再试',
    '52003': '百度翻译未授权，请检查 APP ID 和密钥',
    '54000': '查询参数无效',
    '54001': '百度签名错误，请检查 APP ID 和密钥',
    '54003': '查询过于频繁，请稍后再试',
    '54004': '百度翻译额度不足',
    '54005': '请求过长',
    '58000': '百度拒绝了服务器 IP。请在翻译开放平台关闭 IP 白名单限制',
    '58001': '不支持该语种',
    '58002': '服务当前已关闭',
    '90107': '百度翻译尚未开通该服务',
  };
  return table[code] || ('词典查询失败（' + code + '）');
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
  const appId = (Deno.env.get('BAIDU_FANYI_APP_ID') || '').trim();
  const secret = (Deno.env.get('BAIDU_FANYI_SECRET') || '').trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }
  if (!appId || !secret) {
    return jsonResponse({
      error: 'Baidu translate not configured',
      message: '请在 Edge Functions → Secrets 配置 BAIDU_FANYI_APP_ID 和 BAIDU_FANYI_SECRET',
    }, 500);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized', message: '请先登录后再查词' }, 401);
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user?.id) {
    return jsonResponse({ error: 'Unauthorized', message: '请先登录后再查词' }, 401);
  }

  let word = '';
  try {
    const body = await req.json();
    word = String(body?.word || '').trim().toLowerCase();
  } catch {
    return jsonResponse({ error: 'Invalid JSON', message: '查询参数无效' }, 400);
  }
  word = word.replace(/^'+|'+$/g, '');
  if (!word || word.length > 80) {
    return jsonResponse({ error: 'Invalid word', message: '请选择有效单词' }, 400);
  }

  const salt = String(Date.now());
  const sign = md5(appId + word + salt + secret);
  const params = new URLSearchParams({
    q: word,
    from: 'en',
    to: 'zh',
    appid: appId,
    salt,
    sign,
  });

  let baidu: Record<string, unknown>;
  try {
    const res = await fetch(BAIDU_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    baidu = await res.json();
  } catch {
    return jsonResponse({ error: 'upstream_timeout', message: '词典暂时连不上，请稍后再试' }, 502);
  }

  const errCode = String(baidu?.error_code || '');
  if (errCode && errCode !== '52000') {
    return jsonResponse({
      error: 'baidu_error',
      code: errCode,
      message: mapBaiduError(errCode),
    }, 502);
  }

  const rows = Array.isArray(baidu?.trans_result) ? baidu.trans_result as Array<Record<string, unknown>> : [];
  const zh = String(rows[0]?.dst || '').trim();
  if (!zh) {
    return jsonResponse({ error: 'empty', message: '暂无该词释义' }, 404);
  }

  return jsonResponse({
    ok: true,
    word,
    phonetic: '',
    zh,
    meanings: [{
      partOfSpeech: '释义',
      definitions: [{ definition: zh }],
    }],
  });
});
