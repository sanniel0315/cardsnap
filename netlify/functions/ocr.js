/* CardSnap 雲端 OCR 代理 — 呼叫 Google Cloud Vision(金鑰存 Netlify 環境變數 VISION_API_KEY)
   前端 POST { image: base64(JPEG,無前綴), langHints: [...] } → 回 { text }            */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return resp(405, { error: 'Method Not Allowed' });

  const key = process.env.VISION_API_KEY;
  if (!key) return resp(501, { error: '尚未設定 VISION_API_KEY,請在 Netlify 環境變數加入金鑰' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return resp(400, { error: 'bad json' }); }
  const image = body.image;
  const langHints = Array.isArray(body.langHints) && body.langHints.length ? body.langHints : ['zh-Hant', 'en'];
  if (!image) return resp(400, { error: 'no image' });

  const payload = {
    requests: [{
      image: { content: image },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      imageContext: { languageHints: langHints },
    }],
  };

  try {
    const r = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.error) return resp(502, { error: data.error.message || 'vision error' });
    const a = (data.responses && data.responses[0]) || {};
    const text = (a.fullTextAnnotation && a.fullTextAnnotation.text)
      || (a.textAnnotations && a.textAnnotations[0] && a.textAnnotations[0].description) || '';
    return resp(200, { text });
  } catch (e) {
    return resp(502, { error: String((e && e.message) || e) });
  }
};

function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}
function resp(code, obj) {
  return { statusCode: code, headers: Object.assign({ 'Content-Type': 'application/json' }, cors()), body: JSON.stringify(obj) };
}
