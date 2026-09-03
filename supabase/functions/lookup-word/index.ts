/**
 * Edge Function: lookup-word
 *
 * JWT 鉴权 → 经服务器请求 Wiktionary 英英释义（用户浏览器不直连国外词典）。
 * 不使用百度翻译，避免中文释义。
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const WIKT_URL = 'https://en.wiktionary.org/api/rest_v1/page/definition/';
const UA = 'AIEnglishReadingAssistant/1.0 (https://www.aijingdu.com; word lookup)';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Meaning = {
  partOfSpeech: string;
  definitions: Array<{ definition: string; example?: string }>;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function stripHtml(raw: string): string {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMeanings(payload: unknown): Meaning[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const groups = Array.isArray(root.en) ? root.en : [];
  const meanings: Meaning[] = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    const g = group as Record<string, unknown>;
    const pos = String(g.partOfSpeech || '').trim();
    const defsRaw = Array.isArray(g.definitions) ? g.definitions : [];
    const definitions: Meaning['definitions'] = [];
    for (const item of defsRaw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const text = stripHtml(String(row.definition || ''));
      if (!text) continue;
      const examples = Array.isArray(row.examples) ? row.examples : [];
      const example = stripHtml(String(examples[0] || ''));
      definitions.push(example ? { definition: text, example } : { definition: text });
    }
    if (definitions.length) {
      meanings.push({ partOfSpeech: pos || 'English', definitions: definitions.slice(0, 3) });
    }
    if (meanings.length >= 4) break;
  }
  return meanings;
}

async function fetchWiktionary(term: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(WIKT_URL + encodeURIComponent(term), {
    headers: {
      'Accept': 'application/json',
      'User-Agent': UA,
      'Api-User-Agent': UA,
    },
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
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
  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: 'Server misconfigured' }, 500);
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

  const candidates = [word];
  const titled = word.charAt(0).toUpperCase() + word.slice(1);
  if (titled !== word) candidates.push(titled);

  try {
    let meanings: Meaning[] = [];
    let lastStatus = 0;
    for (const term of candidates) {
      const { status, json } = await fetchWiktionary(term);
      lastStatus = status;
      if (status === 404) continue;
      if (status >= 500) {
        return jsonResponse({ error: 'upstream', message: '词典暂时连不上，请稍后再试' }, 502);
      }
      if (!status.toString().startsWith('2')) continue;
      meanings = parseMeanings(json);
      if (meanings.length) break;
    }

    if (!meanings.length) {
      const msg = lastStatus === 404 ? '暂无该词英文释义' : '暂无该词英文释义';
      return jsonResponse({ error: 'empty', message: msg }, 404);
    }

    return jsonResponse({
      ok: true,
      source: 'wiktionary',
      word,
      phonetic: '',
      meanings,
    });
  } catch {
    return jsonResponse({ error: 'upstream_timeout', message: '词典暂时连不上，请稍后再试' }, 502);
  }
});
