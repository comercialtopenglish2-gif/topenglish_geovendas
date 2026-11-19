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
// Se o modelo configurado não existir mais na conta, tenta estes em ordem (pode trocar por AI_MODEL_FALLBACK, separados por vírgula)
const RESERVA = (process.env.AI_MODEL_FALLBACK || "claude-sonnet-5-5,claude-haiku-5-5,claude-sonnet-4-5,claude-haiku-4-5").split(",").map(x => x.trim()).filter(Boolean);
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

// Lê o erro da Anthropic e devolve {status, code, message} em português, sem expor a chave
async function motivo(up, modelo) {
  let tipo = "", msg = "";
  try { const j = JSON.parse(await up.text()); tipo = (j.error && j.error.type) || ""; msg = String((j.error && j.error.message) || ""); } catch {}
  console.error(`IA: a Anthropic respondeu HTTP ${up.status} (${tipo || "sem tipo"}) com o modelo ${modelo}: ${msg.slice(0, 300)}`);
  if (up.status === 401) return { status: 502, code: "unavailable", message: "A chave da IA no servidor foi recusada pela Anthropic. Confira a variável ANTHROPIC_API_KEY no Railway." };
  if (up.status === 403) return { status: 502, code: "unavailable", message: "A conta da Anthropic não tem permissão para este uso. Confira a conta e a chave no console da Anthropic." };
  if (/credit balance|billing|purchase credits/i.test(msg)) return { status: 502, code: "unavailable", message: "Os créditos da conta da Anthropic acabaram. Recarregue em console.anthropic.com (Billing) e tente de novo." };
  if (up.status === 404 || tipo === "not_found_error") return { status: 502, code: "model_not_found", message: `O modelo de IA "${modelo}" não foi encontrado na conta. Ajuste AI_MODEL_DEFAULT no Railway.` };
  if (up.status === 413 || /prompt is too long|too many tokens|exceeds/i.test(msg)) return { status: 413, code: "prompt_too_large", message: "Há dados demais para uma pergunta só. Remova arquivos anexados ou pergunte sobre um período menor." };
  if (up.status === 429 || up.status === 529 || tipo === "overloaded_error" || tipo === "rate_limit_error") return { status: 429, code: "rate_limited", message: "A IA está sobrecarregada agora. Espere alguns segundos e tente de novo." };
  if (up.status === 400) return { status: 502, code: "invalid_argument", message: "A IA recusou o formato do pedido. Tente de novo; se continuar, avise o suporte do GeoVenda." };
  return { status: 502, code: "unavailable", message: "A IA não respondeu agora. Tente de novo em instantes." };
}
const espera = ms => new Promise(r => setTimeout(r, ms));
async function chamar(corpoApi, signal) {
  return fetch(API, {
    method: "POST", signal,
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(corpoApi),
  });
}
// Tenta o modelo pedido; se ele não existir, os modelos de reserva; se a IA estiver sobrecarregada, tenta de novo uma vez
async function chamarComReserva(base, modelo, signal) {
  const fila = [modelo, ...RESERVA.filter(m => m !== modelo)];
  let ultimo = null;
  for (let i = 0; i < fila.length; i++) {
    let up = await chamar({ ...base, model: fila[i] }, signal);
    if (!up.ok && (up.status === 429 || up.status === 529 || up.status >= 500)) { try { await up.text(); } catch {} await espera(1500); up = await chamar({ ...base, model: fila[i] }, signal); }
    if (up.ok) { if (i > 0) console.error(`IA: usando o modelo de reserva ${fila[i]} (o configurado não respondeu).`); return { up, modelo: fila[i] }; }
    ultimo = await motivo(up, fila[i]);
    if (ultimo.code !== "model_not_found") return { erro: ultimo };
  }
  return { erro: ultimo };
}

// Teste rápido para o franqueador: GET /api/ai/diagnostico
export async function diagnostico(req, res) {
  if (!iaLigada()) return res.json({ ok: false, motivo: "A variável ANTHROPIC_API_KEY não está configurada no Railway." });
  try {
    const r = await chamarComReserva({ max_tokens: 20, messages: [{ role: "user", content: "Responda só: ok" }] }, MODELOS.default, undefined);
    if (r.erro) return res.json({ ok: false, motivo: r.erro.message });
    let txt = ""; try { const j = await r.up.json(); txt = (j.content || []).map(c => c.text || "").join(""); } catch {}
    res.json({ ok: true, modelo: r.modelo, resposta: txt.slice(0, 40) });
  } catch (e) { res.json({ ok: false, motivo: "Não consegui falar com a Anthropic a partir do servidor." }); }
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
    const r = await chamarComReserva({ max_tokens: Math.min(Number(corpo.maxTokens) || MAX_TOKENS, MAX_TOKENS), messages: mensagens, stream: true }, MODELOS[corpo.modelTier] || MODELOS.default, ctl.signal);
    if (r.erro) return erro(res, r.erro.status, r.erro.code === "model_not_found" ? "unavailable" : r.erro.code, r.erro.message);
    up = r.up;
  } catch (e) {
    if (!ctl.signal.aborted) console.error("IA: falha de rede ao chamar a Anthropic:", e && e.message);
    return erro(res, 502, ctl.signal.aborted ? "cancelled" : "unavailable", "Não consegui falar com a IA agora. Tente de novo em instantes.");
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
        else if (ev.type === "error") { console.error("IA: erro no meio da resposta:", ev.error && ev.error.type); return erro(res, 502, "unavailable", ev.error && ev.error.type === "overloaded_error" ? "A IA está sobrecarregada agora. Espere alguns segundos e tente de novo." : "A IA interrompeu a resposta. Tente de novo."); }
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
