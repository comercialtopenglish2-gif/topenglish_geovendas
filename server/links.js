// Links rastreáveis (decisão da usuária em 25/11/2026): link curto /l/<código> que conta o clique
// e redireciona para o WhatsApp (número + mensagem) ou para um site com UTM.
// A rota /l/<código> é a única exceção pública aprovada: não mostra dados, só redireciona.
// Escopo: o master vê e edita só os links do espaço dele (unidade do CMS); o franqueador vê todos.
import crypto from "node:crypto";
import { getPool } from "./db.js";

export const REDES = {
  ig: "Instagram (bio)", igs: "Instagram (stories)", fb: "Facebook", tt: "TikTok", yt: "YouTube",
  gmb: "Google Meu Negócio", li: "LinkedIn", wa: "Status do WhatsApp", site: "Site", qr: "Panfleto / QR Code",
  ind: "Indicação", email: "E-mail", outro: "Outro",
};
const FUSO = "America/Sao_Paulo";
const CODIGO = /^[a-z0-9]{6,12}$/;
const ALFABETO = "abcdefghjkmnpqrstuvwxyz23456789";

class ErroLink extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

function novoCodigo() {
  const b = crypto.randomBytes(7);
  return Array.from(b, x => ALFABETO[x % ALFABETO.length]).join("");
}
const limpa = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

export function numeroWhats(n) {
  let d = String(n || "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d; // número brasileiro sem o código do país
  return d.length >= 12 && d.length <= 15 ? d : null;
}
// Monta o destino no servidor: o navegador nunca escolhe uma URL arbitrária sem validação
export function destinoDe(l, codigo) {
  if (l.tipo === "whatsapp") {
    const num = numeroWhats(l.numero);
    if (!num) throw new ErroLink(400, "invalid_argument", "Informe um WhatsApp válido, com DDD (ex.: 35 99999-0000).");
    return "https://wa.me/" + num + (l.mensagem ? "?text=" + encodeURIComponent(l.mensagem) : "");
  }
  let u;
  try { u = new URL(String(l.url || "").trim()); } catch { throw new ErroLink(400, "invalid_argument", "Informe o endereço completo do site, começando com https://"); }
  if (!/^https?:$/.test(u.protocol)) throw new ErroLink(400, "invalid_argument", "O site precisa começar com http:// ou https://");
  u.searchParams.set("utm_source", l.rede);
  u.searchParams.set("utm_medium", "organic");
  u.searchParams.set("utm_campaign", l.campanha ? l.campanha.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "geovenda" : "geovenda");
  u.searchParams.set("utm_content", codigo);
  return u.toString();
}

function dados(body) {
  const tipo = body.tipo === "site" ? "site" : "whatsapp";
  const rede = REDES[body.rede] ? body.rede : "outro";
  return {
    tipo, rede,
    nome: limpa(body.nome, 80) || (tipo === "whatsapp" ? "WhatsApp" : "Site") + " · " + REDES[rede],
    numero: tipo === "whatsapp" ? limpa(body.numero, 30) : "",
    mensagem: tipo === "whatsapp" ? limpa(body.mensagem, 600) : "",
    url: tipo === "site" ? limpa(body.url, 500) : "",
    campanha: limpa(body.campanha, 60),
  };
}
const dono = id => id.espaco || id.pessoaId;

export async function criar(id, body) {
  const d = dados(body || {});
  for (let t = 0; t < 5; t++) {
    const codigo = novoCodigo(), destino = destinoDe(d, codigo);
    try {
      const r = await getPool().query(
        `INSERT INTO links(codigo,espaco,criado_por,unidade,nome,tipo,rede,numero,mensagem,url,campanha,destino)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [codigo, dono(id), id.pessoaId, id.unidade || "", d.nome, d.tipo, d.rede, d.numero, d.mensagem, d.url, d.campanha, destino]);
      return r.rows[0];
    } catch (e) { if (e.code !== "23505") throw e; } // código repetido: tenta outro
  }
  throw new ErroLink(500, "unavailable", "Não consegui gerar o código do link. Tente de novo.");
}

async function doEscopo(id, codigo) {
  if (!CODIGO.test(String(codigo || ""))) throw new ErroLink(404, "not_found", "Link não encontrado.");
  const r = await getPool().query("SELECT * FROM links WHERE codigo=$1", [codigo]);
  const l = r.rows[0];
  if (!l || (!id.master && l.espaco !== dono(id))) throw new ErroLink(404, "not_found", "Link não encontrado.");
  return l;
}

export async function editar(id, codigo, body) {
  const l = await doEscopo(id, codigo);
  const b = body || {};
  const d = dados({ ...l, ...b, tipo: l.tipo });
  const ativo = typeof b.ativo === "boolean" ? b.ativo : l.ativo;
  const destino = destinoDe(d, l.codigo);
  const r = await getPool().query(
    "UPDATE links SET nome=$2,rede=$3,numero=$4,mensagem=$5,url=$6,campanha=$7,destino=$8,ativo=$9 WHERE codigo=$1 RETURNING *",
    [l.codigo, d.nome, d.rede, d.numero, d.mensagem, d.url, d.campanha, destino, ativo]);
  return r.rows[0];
}

export async function apagar(id, codigo) {
  const l = await doEscopo(id, codigo);
  await getPool().query("DELETE FROM links WHERE codigo=$1", [l.codigo]);
}

// Lista com cliques (total, 7 e 30 dias) e a série por dia e por rede dos últimos `dias`
export async function listar(id, dias = 30) {
  dias = Math.min(Math.max(Number(dias) || 30, 7), 180);
  const onde = id.master ? "TRUE" : "l.espaco=$1";
  const args = id.master ? [] : [dono(id)];
  const n = args.length;
  const links = await getPool().query(
    `SELECT l.*, COUNT(c.id)::int AS cliques,
            COUNT(c.id) FILTER (WHERE c.em >= now() - interval '7 days')::int AS cliques7,
            COUNT(c.id) FILTER (WHERE c.em >= now() - interval '30 days')::int AS cliques30,
            MAX(c.em) AS ultimo
       FROM links l LEFT JOIN link_cliques c ON c.codigo=l.codigo
      WHERE ${onde} GROUP BY l.codigo ORDER BY l.criado DESC`, args);
  const serie = await getPool().query(
    `SELECT to_char(c.em AT TIME ZONE '${FUSO}','YYYY-MM-DD') AS dia, l.rede, COUNT(*)::int AS cliques
       FROM link_cliques c JOIN links l ON l.codigo=c.codigo
      WHERE ${onde} AND c.em >= now() - ($${n + 1}::int * interval '1 day')
      GROUP BY 1,2 ORDER BY 1`, [...args, dias]);
  return { redes: REDES, dias, links: links.rows, serie: serie.rows };
}

// ---------- rota pública /l/:codigo ----------
const ROBO = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|embedly|curl|wget|python|headless/i;
const recentes = new Map(); // evita contar duas vezes o mesmo clique repetido em poucos segundos (sem gravar IP)
export async function redirecionar(req, res) {
  const codigo = String(req.params.codigo || "").toLowerCase();
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex");
  const fora = () => res.status(404).type("html").send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link indisponível</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#334"><p>Este link não está mais disponível.</p></body>');
  if (!CODIGO.test(codigo)) return fora();
  let l;
  try { l = (await getPool().query("SELECT codigo,destino,ativo FROM links WHERE codigo=$1", [codigo])).rows[0]; }
  catch (e) { return res.status(503).type("html").send("Tente de novo em instantes."); }
  if (!l || !l.ativo) return fora();
  const ua = String(req.get("user-agent") || "");
  const chave = codigo + "|" + crypto.createHash("sha256").update((req.ip || "") + ua).digest("hex").slice(0, 16);
  const agora = Date.now();
  if (req.method === "GET" && !ROBO.test(ua) && !(recentes.get(chave) > agora - 10000)) {
    recentes.set(chave, agora);
    if (recentes.size > 5000) for (const [k, t] of recentes) if (t < agora - 10000) recentes.delete(k);
    getPool().query("INSERT INTO link_cliques(codigo) VALUES ($1)", [codigo]).catch(e => console.error("Links: não consegui contar o clique:", e.message));
  }
  res.redirect(302, l.destino);
}

export function trata(res, e) {
  if (e instanceof ErroLink) return res.status(e.status).json({ code: e.code, message: e.message });
  console.error("Links:", e && e.message);
  res.status(500).json({ code: "unavailable", message: "Não consegui concluir agora. Tente de novo." });
}
