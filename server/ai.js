// Proxy da IA (decisão D5a): o navegador fala com /api/ai/sample; o servidor chama a API da Anthropic
// com a chave guardada no Railway. Limite diário por pessoa.
import { getPool } from "./db.js";

const API = process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages"; // a URL só muda em testes locais
// Modelos configuráveis por variável de ambiente. Confira os nomes atuais em https://docs.claude.com antes do deploy.
const MODELOS = {
  quick: process.env.AI_MODEL_QUICK || "claude-haiku-5-5",
  default: process.env.AI_MODEL_DEFAULT || "claude-sonnet-5-5",
  complex: process.env.AI_MODEL_COMPLEX || "claude-sonnet-5-5",
};
const MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 8000);
const LIMITE_DIA = Number(process.env.AI_DAILY_CALLS || 150);
export const MAX_PROMPT_BYTES = 262144;
export const IMAGENS = { maxCount: 4, maxBytes: 5 * 1024 * 1024, types: ["image/jpeg", "image/png", "image/webp", "image/gif"] };

export const iaLigada = () => !!process.env.ANTHROPIC_API_KEY;

function erro(res, status, code, message) {
  if (!res.headersSent) res.status(status).json({ code, message });
  else { res.write(JSON.stringify({ t: "erro", code, message }) + "\n"); res.end(); }
}

async function contarUso(pessoa) {
  const r = await getPool().query(
    `INSERT INTO uso_ia(pessoa,dia,chamadas) VALUES ($1,current_date,1)
     ON CONFLICT (pessoa,dia) DO UPDATE SET chamadas=uso_ia.chamadas+1 RETURNING chamadas`, [pessoa]);
  return r.rows[0].chamadas;
}
async function somarTokens(pessoa, ti, to) {
  await getPool().query("UPDATE uso_ia SET tokens_in=tokens_in+$2, tokens_out=tokens_out+$3 WHERE pessoa=$1 AND dia=current_date", [pessoa, ti || 0, to || 0]);
}

// Normaliza a entrada do front: string ou [{role, content}], mais imagens [{media_type, data(base64)}]
function montarMensagens(input, imagens) {
  let msgs;
  if (typeof input === "string") msgs = [{ role: "user", content: input }];
  else if (Array.isArray(input)) msgs = input.map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));
  else throw Object.assign(new Error("Entrada inválida."), { code: "invalid_argument" });
  // a API exige alternância começando por user: junta mensagens seguidas do mesmo papel
  const out = [];
  for (const m of msgs) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n\n" + m.content;
    else out.push({ ...m });
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: "(início)" });
  if (out[out.length - 1].role !== "user") out.push({ role: "user", content: "Continue." });
  if (Array.isArray(imagens) && imagens.length) {
    if (imagens.length > IMAGENS.maxCount) throw Object.assign(new Error("Imagens demais."), { code: "image_rejected" });
    const blocos = imagens.map(im => {
      if (!IMAGENS.types.includes(im.media_type) || typeof im.data !== "string") throw Object.assign(new Error("Imagem inválida."), { code: "image_rejected" });
      if (Buffer.byteLength(im.data, "base64") > IMAGENS.maxBytes) throw Object.assign(new Error("Imagem grande demais."), { code: "image_rejected" });
      return { type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } };
    });
    const ult = out[out.length - 1];
    ult.content = [...blocos, { type: "text", text: ult.content }];
  }
  return out;
}

// POST /api/ai/sample  { input, images?, modelTier?, maxTokens? }
// Resposta em NDJSON: {"t":"delta","text":"..."} ... {"t":"fim","text":"...","truncated":bool}
export async function sample(req, res, ident) {
  if (!iaLigada()) return erro(res, 503, "sampling_disabled", "A IA está desligada neste servidor.");
  const corpo = req.body || {};
  const bruto = JSON.stringify(corpo.input ?? "");
  if (Buffer.byteLength(bruto) > MAX_PROMPT_BYTES * 1.2) return erro(res, 413, "invalid_argument", "Pedido grande demais.");
  let mensagens;
  try { mensagens = montarMensagens(corpo.input, corpo.images); }
  catch (e) { return erro(res, 400, e.code || "invalid_argument", e.message); }
  const n = await contarUso(ident.pessoaId);
  if (n > LIMITE_DIA) return erro(res, 429, "rate_limited", "Limite diário de IA atingido. Tente amanhã.");

  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
  let up;
  try {
    up = await fetch(API, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODELOS[corpo.modelTier] || MODELOS.default, max_tokens: Math.min(Number(corpo.maxTokens) || MAX_TOKENS, MAX_TOKENS), messages: mensagens, stream: true }),
    });
  } catch (e) {
    return erro(res, 502, ctl.signal.aborted ? "cancelled" : "unavailable", "Não consegui falar com a IA agora.");
  }
  if (!up.ok) {
    const code = up.status === 429 || up.status === 529 ? "rate_limited" : up.status === 400 ? "invalid_argument" : "unavailable";
    try { await up.text(); } catch {}
    return erro(res, up.status === 429 || up.status === 529 ? 429 : 502, code, "A IA não respondeu agora. Tente de novo.");
  }
  res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  let texto = "", parada = null, ti = 0, to = 0, buf = "";
  const dec = new TextDecoder();
  try {
    for await (const chunk of up.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const linha = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!linha.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(linha.slice(5)); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          texto += ev.delta.text; res.write(JSON.stringify({ t: "delta", text: ev.delta.text }) + "\n");
        } else if (ev.type === "message_start" && ev.message && ev.message.usage) ti = ev.message.usage.input_tokens || 0;
        else if (ev.type === "message_delta") { if (ev.delta && ev.delta.stop_reason) parada = ev.delta.stop_reason; if (ev.usage) to = ev.usage.output_tokens || to; }
        else if (ev.type === "error") { return erro(res, 502, "unavailable", "A IA interrompeu a resposta."); }
      }
    }
  } catch (e) {
    if (ctl.signal.aborted) return; // o usuário clicou em Parar
    return erro(res, 502, "unavailable", "A resposta da IA foi interrompida.");
  }
  somarTokens(ident.pessoaId, ti, to).catch(() => {});
  if (parada === "refusal") { res.write(JSON.stringify({ t: "erro", code: "refused", message: "A IA recusou este pedido." }) + "\n"); return res.end(); }
  res.write(JSON.stringify({ t: "fim", text: texto, truncated: parada === "max_tokens" }) + "\n");
  res.end();
}

export function limites() {
  return { maxPromptBytes: MAX_PROMPT_BYTES, images: iaLigada() ? IMAGENS : false };
}
