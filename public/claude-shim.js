/* GeoVenda · camada de compatibilidade com window.claude.use(...)
 * Mantém a mesma interface que o index.html já usa dentro do Claude, mas fala com o servidor do GeoVenda:
 *   user      -> /api/session e /api/pessoas
 *   db        -> /api/db/*  (estilo Firestore; onSnapshot por polling)
 *   sample    -> /api/ai/*  (texto em streaming, conversa, imagens, json, limits)
 *   downloads -> download direto no navegador
 * A identidade vem SÓ do servidor (window.GV_SESSION, injetado no index.html a cada requisição).
 */
(function () {
  "use strict";
  var S = window.GV_SESSION;
  if (!S || !S.pessoa) { location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search); return; }

  // ---------- troca de conta: limpa o cache local que pertence a outra pessoa ----------
  var CACHE_DA_CONTA = [/^vcnc_(?!aba$)/, /^geofunil-local-v1$/, /^geofunil-unit$/, /^gv_assist_chat$/];
  try {
    var anterior = localStorage.getItem("gv_conta");
    if (anterior && anterior !== S.pessoa.id) {
      Object.keys(localStorage).forEach(function (k) { if (CACHE_DA_CONTA.some(function (r) { return r.test(k); })) localStorage.removeItem(k); });
    }
    localStorage.setItem("gv_conta", S.pessoa.id);
  } catch (e) {}

  function irParaLogin() { location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search + location.hash); }
  function erro(code, message, extra) { var e = new Error(message || code); e.code = code; if (extra) Object.assign(e, extra); return e; }

  async function api(url, corpo, opts) {
    var r;
    try {
      r = await fetch(url, Object.assign({ method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo || {}) }, opts || {}));
    } catch (e) {
      if (e && e.name === "AbortError") throw erro("cancelled", "Cancelado.");
      throw erro("unavailable", "Sem conexão com o servidor.");
    }
    if (r.status === 401) { irParaLogin(); throw erro("unauthenticated", "Sessão expirada."); }
    return r;
  }
  async function apiJson(url, corpo) {
    var r = await api(url, corpo);
    var j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw erro((j && j.code) || "unavailable", (j && j.message) || "Erro no servidor.");
    return j;
  }
  var clone = function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); };

  // ---------- user ----------
  var user = {
    id: async function () { return S.pessoa.id; },
    me: async function () { return { id: S.pessoa.id, name: S.pessoa.nome || "", email: null, avatarUrl: null, isOwner: !!S.master }; },
    isOwner: async function () { return !!S.master; },
    can: async function () { return true; },
    canEdit: function () { return !!S.editaBase; },
    profiles: async function (ids) { return apiJson("/api/pessoas", { ids: ids || [] }); },
    search: async function () { return []; }
  };

  // ---------- db (estilo Firestore) ----------
  var ouvintes = new Set();
  var POLL_MS = 4000;
  function cutucar() { ouvintes.forEach(function (o) { o.agendar(150); }); }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) cutucar(); });

  function snapDoc(path, res) {
    var id = path.split("/").pop(), dados = res.exists ? res.data : null;
    return { id: id, exists: !!res.exists, ref: docRef(path), data: function () { return dados == null ? undefined : clone(dados); }, metadata: { fromCache: false } };
  }
  function snapCol(path, docs) {
    var lista = docs.map(function (d) { return snapDoc(path + "/" + d.id, { exists: true, data: d.data }); });
    return { docs: lista, size: lista.length, empty: !lista.length, forEach: function (f) { lista.forEach(f); }, metadata: { fromCache: false } };
  }
  function ouvinte(executar, cb, errCb) {
    var o = { ativo: true, t: null, rodando: false };
    o.agendar = function (ms) { if (!o.ativo) return; clearTimeout(o.t); o.t = setTimeout(o.rodar, ms); };
    o.rodar = async function () {
      if (!o.ativo || o.rodando) return;
      if (document.hidden) { o.agendar(POLL_MS); return; }
      o.rodando = true;
      try { await executar(cb); o.agendar(POLL_MS); }
      catch (e) {
        if (e && (e.code === "permission_denied" || e.code === "invalid_argument" || e.code === "pendente" || e.code === "unauthenticated")) { o.ativo = false; ouvintes.delete(o); if (errCb) try { errCb(e); } catch (x) {} }
        else o.agendar(POLL_MS * 2);
      } finally { o.rodando = false; }
    };
    ouvintes.add(o); o.agendar(0);
    return function () { o.ativo = false; clearTimeout(o.t); ouvintes.delete(o); };
  }
  function novoId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  function docRef(path) {
    return {
      id: path.split("/").pop(), path: path,
      get: async function () { return snapDoc(path, await apiJson("/api/db/get", { path: path })); },
      set: async function (data) { await apiJson("/api/db/set", { path: path, data: clone(data) }); cutucar(); },
      update: async function (data) { await apiJson("/api/db/update", { path: path, data: clone(data) }); cutucar(); },
      delete: async function () { await apiJson("/api/db/delete", { path: path }); cutucar(); },
      onSnapshot: function (cb, errCb) {
        var versao = -1;
        return ouvinte(async function (f) {
          var r = await apiJson("/api/db/get", { path: path });
          var v = r.exists ? r.versao : 0;
          if (v !== versao) { versao = v; f(snapDoc(path, r)); }
        }, cb, errCb);
      },
      collection: function (sub) { return colRef(path + "/" + sub); }
    };
  }
  function colRef(path, where) {
    return {
      id: path.split("/").pop(), path: path,
      doc: function (id) { return docRef(path + "/" + (id || novoId())); },
      where: function (campo, op, valor) {
        if (op !== "==") throw erro("invalid_argument", "Filtro não suportado: " + op);
        return colRef(path, [campo, op, valor]);
      },
      get: async function () { var r = await apiJson("/api/db/list", { path: path, where: where || null }); return snapCol(path, r.docs || []); },
      add: async function (data) { var ref = docRef(path + "/" + novoId()); await ref.set(data); return ref; },
      onSnapshot: function (cb, errCb) {
        var token = null;
        return ouvinte(async function (f) {
          var r = await apiJson("/api/db/list", { path: path, where: where || null, since: token });
          if (r.unchanged) return;
          token = r.token; f(snapCol(path, r.docs || []));
        }, cb, errCb);
      }
    };
  }
  var db = { collection: function (p) { return colRef(p); }, doc: function (p) { return docRef(p); } };

  // ---------- sample (IA) ----------
  var limitesCache = null;
  async function limits() {
    if (!limitesCache) { var r = await api("/api/ai/limits", null, { method: "GET", body: undefined, headers: {} }); limitesCache = await r.json(); }
    return limitesCache;
  }
  function blobParaBase64(b) {
    return new Promise(function (ok, falha) {
      var fr = new FileReader();
      fr.onload = function () { var s = String(fr.result); ok({ media_type: b.type || "image/png", data: s.slice(s.indexOf(",") + 1) }); };
      fr.onerror = function () { falha(erro("image_rejected", "Não consegui ler a imagem.")); };
      fr.readAsDataURL(b);
    });
  }
  // Nome da tela de onde a IA foi chamada (vai para o relatório de uso por função)
  function funcaoAtual() {
    try {
      var d = (window.top && window.top.document) || document;
      var b = d.querySelector('#gvNav button[aria-current="page"]');
      if (b) { var t = Array.prototype.filter.call(b.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return n.textContent; }).join("").trim(); if (t) return t; }
    } catch (e) {}
    if (/campanhas/i.test(location.pathname)) return "Campanhas e brindes";
    return "Outros";
  }
  function avisarUso() { try { (window.top || window).dispatchEvent(new CustomEvent("gv-ia-uso")); } catch (e) { try { window.dispatchEvent(new CustomEvent("gv-ia-uso")); } catch (x) {} } }
  async function sample(input, opts) {
    try { return await sampleBruto(input, opts); } finally { avisarUso(); }
  }
  async function sampleBruto(input, opts) {
    opts = opts || {};
    var imgs = opts.images ? (Array.isArray(opts.images) ? opts.images : [opts.images]) : [];
    var images = [];
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (im instanceof Blob) images.push(await blobParaBase64(im));
      else if (im && im.data && im.media_type) images.push(im);
    }
    var ctl = new AbortController();
    if (opts.signal) { if (opts.signal.aborted) ctl.abort(); else opts.signal.addEventListener("abort", function () { ctl.abort(); }); }
    var texto = "";
    var r;
    try { r = await api("/api/ai/sample", { input: input, images: images, modelTier: opts.modelTier || "default", feature: String(opts.feature || funcaoAtual()).slice(0, 80) }, { signal: ctl.signal }); }
    catch (e) { if (ctl.signal.aborted) throw erro("cancelled", "Cancelado.", { text: texto }); throw e; }
    if (!r.ok) { var j = null; try { j = await r.json(); } catch (e) {} throw erro((j && j.code) || "unavailable", (j && j.message) || "IA indisponível."); }
    var leitor = r.body.getReader(), dec = new TextDecoder(), buf = "", fim = null;
    try {
      for (;;) {
        var parte = await leitor.read();
        if (parte.done) break;
        buf += dec.decode(parte.value, { stream: true });
        var k;
        while ((k = buf.indexOf("\n")) >= 0) {
          var linha = buf.slice(0, k); buf = buf.slice(k + 1);
          if (!linha.trim()) continue;
          var ev = JSON.parse(linha);
          if (ev.t === "delta") { texto += ev.text; if (opts.onText) try { opts.onText({ text: texto, delta: ev.text }); } catch (x) {} }
          else if (ev.t === "fim") fim = ev;
          else if (ev.t === "erro") throw erro(ev.code || "unavailable", ev.message, { text: texto });
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) throw erro("cancelled", "Cancelado.", { text: texto });
      throw e.code ? e : erro("unavailable", "A resposta foi interrompida.", { text: texto });
    }
    if (!fim) throw erro("unavailable", "A resposta foi interrompida.", { text: texto });
    if (!fim.text.trim()) throw erro("empty_completion", "A IA não respondeu.");
    return { text: fim.text, truncated: !!fim.truncated };
  }
  function extrairJson(t) {
    var s = String(t || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(s); } catch (e) {}
    var a = s.search(/[\[{]/), b = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
    throw erro("invalid_json", "A IA respondeu fora do formato.", { text: t });
  }
  sample.json = async function (input, opts) {
    var reforco = "\n\nResponda SOMENTE com um JSON válido, sem texto antes ou depois e sem bloco de código.";
    var entrada = typeof input === "string" ? input + reforco : (Array.isArray(input) ? input.map(function (m, i, a) { return i === a.length - 1 ? Object.assign({}, m, { content: String(m.content) + reforco }) : m; }) : input);
    var o = Object.assign({}, opts || {}); delete o.onText;
    var r = await sample(entrada, o);
    return extrairJson(r.text);
  };
  sample.limits = limits;

  // ---------- downloads ----------
  var downloads = {
    save: async function (o) {
      var dado = o && o.data;
      var blob = dado instanceof Blob ? dado : new Blob([dado == null ? "" : dado], { type: (o && o.mimeType) || "application/octet-stream" });
      var url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = (o && o.filename) || "arquivo"; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      return { status: "saved" };
    }
  };

  window.claude = {
    use: async function (nome) {
      if (nome === "user") return user;
      if (nome === "db") return db;
      if (nome === "sample") return S.ia ? sample : null;
      if (nome === "downloads") return downloads;
      return null;
    }
  };

  // ---------- quem está logado + Sair (injetado na barra lateral) ----------
  function barraConta() {
    if (document.getElementById("gvConta") || !document.getElementById("gvSide")) return; // só na tela principal
    var alvo = document.getElementById("gvSide") || document.body, antes = alvo.querySelector(".gv-theme");
    var d = document.createElement("div");
    d.id = "gvConta";
    d.setAttribute("style", "margin:12px 14px 6px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.1);color:inherit;font-size:12.5px;line-height:1.35");
    var nome = S.pessoa.nome || "Usuário", u = S.unidade || {};
    var linha2 = S.rotulo + (u.nome ? " · " + u.nome : "") + (u.uf ? " · " + u.uf : "");
    d.innerHTML = '<b style="display:block;font-size:13.5px"></b><span></span><button type="button" style="display:block;margin-top:8px;border:1px solid currentColor;background:none;color:inherit;border-radius:8px;padding:5px 10px;font:inherit;cursor:pointer">Sair</button>';
    d.querySelector("b").textContent = nome; d.querySelector("span").textContent = linha2;
    if (S.master) { var l = document.createElement("a"); l.href = "/acessos"; l.textContent = "Unidades e acessos"; l.setAttribute("style", "display:block;margin-top:6px;color:inherit;text-decoration:underline"); l.onclick = function (e) { var nb = document.querySelector('#gvNav button[data-k="acessos"]'); if (nb && !nb.hidden) { e.preventDefault(); nb.click(); } }; d.insertBefore(l, d.querySelector("button")); }
    d.querySelector("button").onclick = function () {
      fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).finally(function () {
        try { localStorage.removeItem("gv_conta"); } catch (e) {}
        location.replace("/login");
      });
    };
    var bar = document.createElement("button");
    bar.type = "button"; bar.id = "gvIaUso"; bar.title = "Ver o uso de IA do mês";
    bar.setAttribute("style", "display:block;width:100%;margin:10px 0 2px;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer");
    bar.innerHTML = '<span style="display:flex;justify-content:space-between;gap:6px;font-size:11.5px;font-weight:700;letter-spacing:.03em"><span>IA DO MÊS</span><span data-p>…</span></span>' +
      '<span style="display:block;height:8px;margin:5px 0 4px;border-radius:99px;background:rgba(255,255,255,.22);overflow:hidden"><span data-f style="display:block;height:100%;width:0;border-radius:99px;background:#3ccf8e;transition:width .4s"></span></span>' +
      '<span data-t style="display:block;font-size:11px;opacity:.9"></span>';
    bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
    bar.onclick = function () { var b = document.querySelector('#gvNav button[data-k="uso"]'); if (b) b.click(); };
    d.insertBefore(bar, d.querySelector("a") || d.querySelector("button:not(#gvIaUso)"));
    if (antes) alvo.insertBefore(d, antes); else alvo.appendChild(d);
    atualizarUso();
  }
  var fmtUsd = function (v) { return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "USD" }); };
  var tUso = null;
  async function atualizarUso() {
    try {
      var r = await fetch("/api/ai/uso", { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!r.ok) return;
      var u = await r.json(); window.GV_USO = u;
      try { window.dispatchEvent(new CustomEvent("gv-uso-atualizado", { detail: u })); } catch (e) {}
      var bar = document.getElementById("gvIaUso"); if (!bar) return;
      var rest = Math.round(u.restantePct), cor = u.bloqueado || rest <= 10 ? "#ff6b5b" : rest <= 30 ? "#ffc93c" : "#3ccf8e";
      bar.querySelector("[data-p]").textContent = u.bloqueado ? "Limite atingido" : rest + "% restante";
      var f = bar.querySelector("[data-f]"); f.style.width = Math.min(100, u.usadoPct) + "%"; f.style.background = cor;
      bar.querySelector("[data-t]").textContent = u.bloqueado ? "Renova em " + u.ciclo.renovaEm : fmtUsd(u.gasto) + " de " + fmtUsd(u.limite) + " · renova em " + u.ciclo.renovaEm;
      bar.setAttribute("aria-valuenow", String(Math.round(u.usadoPct)));
      bar.setAttribute("aria-label", "Uso de IA do mês: " + fmtUsd(u.gasto) + " de " + fmtUsd(u.limite) + ", " + rest + "% restante");
    } catch (e) {}
  }
  window.GV_ATUALIZAR_USO = atualizarUso;
  window.addEventListener("gv-ia-uso", function () { clearTimeout(tUso); tUso = setTimeout(atualizarUso, 600); });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", barraConta); else barraConta();
})();
